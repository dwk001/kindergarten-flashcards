import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shuffle, Plus, Trash2, Home, ChevronLeft, CheckCircle2, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";

/**
 * Kindergarten Flashcards – Streamlined
 * - Create/edit decks (front, optional back, optional hint)
 * - Editor QoL: focus new card, auto-append blank on first type
 * - Practice mode (endless loop): Wrong / Got it
 * - Test mode (one pass): random order once, no hint toggle, results screen
 * - Server sync via json-server at http://<host>:8086
 * - No backup/restore UI, no casting
 */

// ---------- Types ----------
/** @typedef {{ id:string, front:string, back?:string, hint?:string }} Card */
/** @typedef {{ id:string, name:string, cards:Card[] }} Deck */

// ---------- Helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const LS_KEY = "kinder_flashcards_v3";
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
// Use /api path when behind HTTPS proxy, otherwise use direct port
const API_BASE = window.location.protocol === 'https:' 
  ? `${window.location.protocol}//${window.location.hostname}/api/`
  : `${window.location.protocol}//${window.location.hostname}:8086`;

async function api(method, path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.status !== 204 ? res.json() : null;
  } catch (e) {
    console.warn("API error:", method, path, e.message);
    return null;
  }
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function useLocalStorageState(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
  }, [key, state]);
  return [state, setState];
}

// Sample starter decks (no emoji)
const STARTER_DECKS /** @type {Deck[]} */ = [
  {
    id: "alphabet",
    name: "Alphabet",
    cards: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((ch) => ({
      id: uid(),
      front: ch,
      back: ch.toLowerCase(),
      hint: `Letter ${ch}`,
    })),
  },
  {
    id: "sight",
    name: "Sight Words",
    cards: ["a","I","am","and","at","can","go","in","it","is","like","me","my","no","see","the","to","we","yes","you"].map((w) => ({ id: uid(), front: w, back: `say: ${w}` })),
  },
  {
    id: "cvc",
    name: "CVC Words",
    cards: ["cat","dog","sun","map","pin","bed","cup","fox","hat","log","red","sit"].map((w)=>({ id: uid(), front: w, back: w })),
  },
];

// ---------- Main App ----------
export default function App() {
  const [decks, setDecks] = useLocalStorageState(LS_KEY, STARTER_DECKS);

  // screens: home | mode | practice | test | results | editor
  const [screen, setScreen] = useState(/** @type{"home"|"mode"|"practice"|"test"|"results"|"editor"} */("home"));
  const [activeDeckId, setActiveDeckId] = useState(null);
  
  // Cast state
  const [castSession, setCastSession] = useState(null);
  const [isCasting, setIsCasting] = useState(false);

  // practice state
  const [queue, setQueue] = useState([]); // indices into deck.cards
  const [currentIdx, setCurrentIdx] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [fontScale, setFontScale] = useState(1.2);
  const [uppercase, setUppercase] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [stats, setStats] = useState({ seen: 0, correct: 0 });

  // test state
  const [testQueue, setTestQueue] = useState([]);
  const [testIdx, setTestIdx] = useState(0);
  const [testScore, setTestScore] = useState({ correct: 0, total: 0 });

  // editor state
  const [draftDeck, setDraftDeck] = useState(/** @type {Deck|null} */(null));
  const [isNewDeck, setIsNewDeck] = useState(false);
  const [expandedCards, setExpandedCards] = useState(/** @type {Set<string>} */(new Set()));

  const activeDeck = useMemo(() => decks.find((d) => d.id === activeDeckId) || null, [decks, activeDeckId]);
  const currentCard = activeDeck && queue.length ? activeDeck.cards[queue[currentIdx]] : null;

  // ---- Load decks from the server at startup (seed if server is empty) ----
  useEffect(() => {
    (async () => {
      const serverDecks = await api("GET", "/decks");
      if (Array.isArray(serverDecks)) {
        if (serverDecks.length > 0) {
          setDecks(serverDecks);
        } else {
          await Promise.all(decks.map(d => api("POST", "/decks", d)));
          const refreshed = await api("GET", "/decks");
          if (Array.isArray(refreshed)) setDecks(refreshed);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Cast functionality ----------
  useEffect(() => {
    // eslint-disable-next-line no-undef
    if (typeof window.cast === 'undefined') return;
    
    // eslint-disable-next-line no-undef
    const castContext = window.cast.framework.CastContext.getInstance();
    const sessionChanged = () => {
      const session = castContext.getCurrentSession();
      setCastSession(session);
      setIsCasting(!!session);
    };
    
    // eslint-disable-next-line no-undef
    castContext.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, sessionChanged);
    return () => {
      // eslint-disable-next-line no-undef
      castContext.removeEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, sessionChanged);
    };
  }, []);

  const sendCastMessage = (message) => {
    if (castSession) {
      castSession.sendMessage('urn:x-cast:com.kinderflashcards', message);
    }
  };

  // ---------- Practice mode ----------
  useEffect(() => {
    if (screen !== "practice" || !activeDeck) return;
    const indices = activeDeck.cards.map((_, i) => i);
    const shuffled = shuffleArray(indices);
    setQueue(shuffled);
    setCurrentIdx(0);
    setShowBack(false);
    setStats({ seen: 0, correct: 0 });
    
    // Send initial card to Chromecast if casting
    if (isCasting && activeDeck.cards.length > 0) {
      sendCastMessage({ 
        type: 'card', 
        card: activeDeck.cards[shuffled[0]], 
        showBack: false,
        idx: 1,
        total: shuffled.length 
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, activeDeckId, isCasting]);

  const flip = () => setShowBack((b) => !b);

  const shuffleNow = () => {
    if (!activeDeck) return;
    const indices = activeDeck.cards.map((_, i) => i);
    setQueue(shuffleArray(indices));
    setCurrentIdx(0);
    setShowBack(false);
  };

  const nextPractice = (correct=false) => {
    if (!activeDeck || queue.length === 0) return;
    const q = [...queue];
    const [cur] = q.splice(currentIdx, 1);
    if (correct) {
      q.push(cur); // seen later
    } else {
      q.splice(clamp(currentIdx + 2, 0, q.length), 0, cur); // reinsert after two
    }
    const newIdx = currentIdx >= q.length ? 0 : currentIdx;
    setQueue(q);
    setCurrentIdx(newIdx);
    setShowBack(false);
    setStats((s) => ({ seen: s.seen + 1, correct: s.correct + (correct ? 1 : 0) }));
    
    // Send card to Chromecast if casting
    if (isCasting && activeDeck && activeDeck.cards.length > 0) {
      const nextCard = activeDeck.cards[q[newIdx]];
      sendCastMessage({ 
        type: 'card', 
        card: nextCard, 
        showBack: false,
        idx: newIdx + 1,
        total: q.length 
      });
    }
  };

  // ---------- Test mode ----------
  const startTest = () => {
    if (!activeDeck) return;
    const indices = shuffleArray(activeDeck.cards.map((_, i) => i));
    setTestQueue(indices);
    setTestIdx(0);
    setTestScore({ correct: 0, total: indices.length });
    setShowBack(false);
    setScreen("test");
    
    // Send initial card to Chromecast if casting
    if (isCasting && activeDeck.cards.length > 0) {
      sendCastMessage({ 
        type: 'card', 
        card: activeDeck.cards[indices[0]], 
        showBack: false,
        idx: 1,
        total: indices.length 
      });
    }
  };

  const currentTestCard = activeDeck && testQueue.length ? activeDeck.cards[testQueue[testIdx]] : null;

  const answerTest = (correct) => {
    setTestScore((s) => ({ ...s, correct: s.correct + (correct ? 1 : 0) }));
    if (testIdx + 1 >= testQueue.length) {
      setScreen("results");
      if (isCasting) {
        sendCastMessage({ type: 'results', score: { correct: testScore.correct + (correct ? 1 : 0), total: testQueue.length } });
      }
    } else {
      setTestIdx(testIdx + 1);
      setShowBack(false);
      
      // Send next card to Chromecast if casting
      if (isCasting && activeDeck && activeDeck.cards.length > 0) {
        const nextCard = activeDeck.cards[testQueue[testIdx + 1]];
        sendCastMessage({ 
          type: 'card', 
          card: nextCard, 
          showBack: false,
          idx: testIdx + 2,
          total: testQueue.length 
        });
      }
    }
  };

  // ---------- Deck create/edit ----------
  const startModeChooser = (deckId) => {
    setActiveDeckId(deckId);
    setScreen("mode");
  };

  const startEditDeck = (deckId) => {
    const original = decks.find((d) => d.id === deckId);
    if (!original) return;
    setDraftDeck(JSON.parse(JSON.stringify(original)));
    setIsNewDeck(false);
    setScreen("editor");
  };

  const addDeck = () => {
    const newDeck = { id: uid(), name: "New Deck", cards: [] };
    setDraftDeck(newDeck);
    setIsNewDeck(true);
    setActiveDeckId(newDeck.id);
    setScreen("editor");
    // focus handled after render by focusing the just-added card input (see refs below)
  };

// Focus management: only focus when the user clicks "Add Card"
const frontRefs = useRef(new Map());           // cardId -> input element
const focusOnAddId = useRef(null);             // set ONLY on manual add

useEffect(() => {
  const id = focusOnAddId.current;
  if (id && frontRefs.current.has(id)) {
    frontRefs.current.get(id)?.focus();
    focusOnAddId.current = null;
  }
}, [draftDeck]);

const addBlankCard = (opts = { focus: false }) => {
  if (!draftDeck) return null;
  const newId = uid();
  const card = { id: newId, front: "", back: "", hint: "" };
  setDraftDeck({ ...draftDeck, cards: [...draftDeck.cards, card] });
  if (opts.focus) focusOnAddId.current = newId;   // focus ONLY when requested
  return newId;
};

const addDraftCard = () => {
  const newId = addBlankCard({ focus: true });                  // manual Add Card -> focus it
  return newId;
};

  const toggleCardExpansion = (cardId) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  };


  // When typing in Front: if it was empty and now non-empty, ensure a single trailing blank exists.
  const onFrontChange = (cid, value) => {
    if (!draftDeck) return;
    setDraftDeck((prev) => {
      const deck = { ...prev, cards: prev.cards.map(c => ({ ...c })) };
      const idx = deck.cards.findIndex((c) => c.id === cid);
      if (idx < 0) return prev;
      const wasEmpty = !deck.cards[idx].front;
      deck.cards[idx].front = value;

      const hasTrailingBlank = deck.cards.some(c => !c.front && !c.back && !c.hint);
      if (wasEmpty && value.trim() && !hasTrailingBlank) {
        const newId = uid();
        deck.cards.push({ id: newId, front: "", back: "", hint: "" });
      }
      return deck;
    });
  };

  const updateDraftCard = (cid, patch) => {
    if (!draftDeck) return;
    setDraftDeck({
      ...draftDeck,
      cards: draftDeck.cards.map((c) => (c.id === cid ? { ...c, ...patch } : c)),
    });
  };

  const removeDraftCard = (cid) => {
    if (!draftDeck) return;
    setDraftDeck({
      ...draftDeck,
      cards: draftDeck.cards.filter((c) => c.id !== cid),
    });
  };

  const saveDraft = async () => {
    if (!draftDeck) return;
    const clean = {
      ...draftDeck,
      name: (draftDeck.name || "").trim() || "Untitled Deck",
      cards: (draftDeck.cards || []).map((c) => ({
        id: c.id || uid(),
        front: (c.front || "").trim(),
        back: (c.back || "").trim() || undefined,
        hint: (c.hint || "").trim() || undefined,
      })).filter((c) => c.front.length > 0),
    };

    if (isNewDeck) {
      const created = await api("POST", "/decks", clean);
      if (created?.id && created.id !== clean.id) clean.id = created.id;
      setDecks((ds) => [...ds, clean]);
    } else {
      await api("PUT", `/decks/${clean.id}`, clean);
      setDecks((ds) => ds.map((d) => (d.id === clean.id ? clean : d)));
    }
    setActiveDeckId(clean.id);
    setDraftDeck(null);
    setIsNewDeck(false);
    setScreen("mode");
  };

  const discardDraft = () => {
    setDraftDeck(null);
    if (isNewDeck) {
      setIsNewDeck(false);
      setActiveDeckId(null);
      setScreen("home");
    } else {
      setScreen("mode");
    }
  };

  const deleteDeck = async (deckId) => {
    if (!window.confirm("Delete this deck?")) return;
    await api("DELETE", `/decks/${deckId}`);
    setDecks((d) => d.filter((x) => x.id !== deckId));
    if (activeDeckId === deckId) setActiveDeckId(null);
    setDraftDeck(null);
    setScreen("home");
  };

  const progressPct = stats.seen ? Math.round((stats.correct / stats.seen) * 100) : 0;

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-amber-50 to-amber-100 text-slate-900">
      <div className="mx-auto max-w-7xl p-4 pb-24">
        {/* Top bar */}
        <div className="sticky top-0 z-20 -mx-4 mb-4 flex items-center justify-between bg-gradient-to-b from-amber-50/90 to-amber-100/90 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            {screen !== "home" ? (
              <button
                className="rounded-2xl p-2 active:scale-95"
                onClick={() => {
                  if (screen === "editor" && draftDeck) {
                    if (!window.confirm("Discard changes?")) return;
                    discardDraft();
                  } else if (screen === "practice" || screen === "test" || screen === "results" || screen === "mode") {
                    setScreen(screen === "mode" ? "home" : "mode");
                    if (screen !== "mode") setShowBack(false);
                  }
                }}
                aria-label="Back"
              >
                <ChevronLeft />
              </button>
            ) : (
              <Home className="opacity-70" />
            )}
            <h1 className="text-lg font-bold">Flashcards</h1>
          </div>
          <div className="flex items-center gap-2">
            {/* Cast button - only show on practice/test screens */}
            {(screen === "practice" || screen === "test") && (
              <button
                onClick={() => {
                  // Simply trigger Chrome's native cast picker
                  // eslint-disable-next-line no-undef
                  if (typeof chrome !== 'undefined' && chrome.cast && chrome.cast.requestSession) {
                    // eslint-disable-next-line no-undef
                    chrome.cast.requestSession(() => {}, () => {
                      // If no session available, show info
                      console.log('No cast session available');
                    });
                  } else {
                    alert('Use the three-dot menu (top right) > Cast to display on TV');
                  }
                }}
                className="rounded-full p-2 hover:bg-black/10 active:scale-95"
                title="Cast to TV"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Screens */}
        {screen === "home" && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">Tap a deck to practice or test.</p>

            <div className="grid grid-cols-2 gap-3">
              {decks.map((d) => (
                <button
                  key={d.id}
                  onClick={() => startModeChooser(d.id)}
                  className="rounded-2xl bg-white p-4 text-left shadow hover:shadow-md active:scale-95"
                >
                  <div className="mb-1 line-clamp-2 text-base font-semibold">{d.name}</div>
                  <div className="text-xs text-slate-500">{d.cards.length} cards</div>
                </button>
              ))}
            </div>

            <button onClick={addDeck} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 px-4 py-3 text-white shadow active:scale-95">
              <Plus size={18}/> New Deck
            </button>
          </div>
        )}

        {screen === "mode" && activeDeck && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-white p-4 shadow">
              <div className="text-lg font-bold">{activeDeck.name}</div>
              <div className="text-xs text-slate-500">{activeDeck.cards.length} cards</div>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <button onClick={() => setScreen("practice")} className="rounded-2xl bg-emerald-500 px-4 py-4 text-white font-semibold shadow active:scale-95">Start Practice</button>
              <button onClick={startTest} className="rounded-2xl bg-amber-500 px-4 py-4 text-white font-semibold shadow active:scale-95">Start Test</button>
              <button onClick={() => startEditDeck(activeDeck.id)} className="rounded-2xl bg-white px-4 py-4 font-semibold shadow active:scale-95">✏️ Edit Deck</button>
            </div>
          </div>
        )}

        {screen === "practice" && activeDeck && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">{activeDeck.name} • Practice</div>
                <div className="text-xs text-slate-500">Card {currentIdx + 1} / {queue.length}</div>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <div className="rounded-full bg-white px-2 py-1 shadow">Seen {stats.seen}</div>
                <div className="rounded-full bg-white px-2 py-1 shadow">Correct {stats.correct}</div>
                <div className="rounded-full bg-white px-2 py-1 shadow">{progressPct}%</div>
              </div>
            </div>

            {/* Card */}
            <AnimatePresence mode="wait">
              <motion.div
                key={(currentCard?.id || "") + String(showBack)}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="select-none rounded-3xl bg-white p-6 text-center shadow-lg"
                onClick={flip}
              >
                <div
                  className="mx-auto max-w-full break-words"
                  style={{ fontSize: `${Math.round(48 * fontScale)}px`, lineHeight: 1.1 }}
                >
                  {uppercase ? (showBack ? (currentCard?.back || currentCard?.front || "").toUpperCase() : (currentCard?.front || "").toUpperCase()) : (showBack ? (currentCard?.back || currentCard?.front) : currentCard?.front)}
                </div>
                {(currentCard?.hint && !showBack && showHints) && (
                  <div className="mt-2 text-sm text-slate-500">Hint: {currentCard.hint}</div>
                )}
                <div className="mt-4 text-xs text-slate-400">Tap card to flip</div>
              </motion.div>
            </AnimatePresence>

            <div className="grid grid-cols-2 gap-3">
              <button onClick={shuffleNow} className="flex items-center justify-center gap-2 rounded-2xl bg-white px-4 py-4 shadow active:scale-95">
                <Shuffle/> Shuffle
              </button>
              <button onClick={() => startEditDeck(activeDeck.id)} className="flex items-center justify-center gap-2 rounded-2xl bg-white px-4 py-4 shadow active:scale-95">
                ✏️ Edit Deck
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <button onClick={flip} className="rounded-2xl bg-white px-4 py-5 text-base font-semibold shadow active:scale-95">Reveal</button>
              <button onClick={()=>nextPractice(false)} className="flex items-center justify-center gap-2 rounded-2xl bg-rose-500 px-4 py-5 text-base font-semibold text-white shadow active:scale-95">
                <RotateCcw/> Wrong
              </button>
              <button onClick={()=>nextPractice(true)} className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-5 text-base font-semibold text-white shadow active:scale-95">
                <CheckCircle2/> Got it
              </button>
            </div>

            <div className="rounded-2xl bg-white p-3 shadow">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">Uppercase
                  <input type="checkbox" className="ml-2" checked={uppercase} onChange={(e)=>setUppercase(e.target.checked)} />
                </label>
                <label className="flex items-center gap-2">Show hints
                  <input type="checkbox" className="ml-2" checked={showHints} onChange={(e)=>setShowHints(e.target.checked)} />
                </label>
                <label className="flex items-center gap-2">Font size
                  <input type="range" className="ml-2" min={0.8} max={1.8} step={0.05} value={fontScale} onChange={(e)=>setFontScale(parseFloat(e.target.value))} />
                </label>
              </div>
            </div>
          </div>
        )}

        {screen === "test" && activeDeck && (
          <div className="space-y-4">
            <div className="text-sm font-semibold">{activeDeck.name} • Test</div>
            {/* progress bar */}
            <div className="h-2 w-full rounded-full bg-amber-200 overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${Math.round(((testIdx) / testQueue.length) * 100)}%` }} />
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={(currentTestCard?.id || "") + String(showBack)}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="select-none rounded-3xl bg-white p-6 text-center shadow-lg"
              >
                <div
                  className="mx-auto max-w-full break-words"
                  style={{ fontSize: `${Math.round(48 * fontScale)}px`, lineHeight: 1.1 }}
                >
                  {uppercase ? (currentTestCard?.front || "").toUpperCase() : (currentTestCard?.front)}
                </div>
                <div className="mt-4 text-xs text-slate-400">Choose an answer</div>
              </motion.div>
            </AnimatePresence>

            <div className="grid grid-cols-2 gap-3">
              <button onClick={()=>answerTest(false)} className="flex items-center justify-center gap-2 rounded-2xl bg-rose-500 px-4 py-5 text-base font-semibold text-white shadow active:scale-95">
                <RotateCcw/> Wrong
              </button>
              <button onClick={()=>answerTest(true)} className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-5 text-base font-semibold text-white shadow active:scale-95">
                <CheckCircle2/> Got it
              </button>
            </div>
          </div>
        )}

        {screen === "results" && (() => {
          const percentage = Math.round((testScore.correct / Math.max(1, testScore.total)) * 100);
          let message, colorClass;
          if (percentage === 100) {
            message = "Perfect! 🌟";
            colorClass = "text-emerald-600";
          } else if (percentage >= 80) {
            message = "Great job! 🎉";
            colorClass = "text-emerald-500";
          } else if (percentage >= 60) {
            message = "Good work! 👍";
            colorClass = "text-amber-500";
          } else if (percentage >= 40) {
            message = "Keep practicing! 💪";
            colorClass = "text-amber-600";
          } else if (percentage >= 20) {
            message = "Nice try! Keep going! 🌱";
            colorClass = "text-orange-500";
          } else {
            message = "Let's practice together! 🌈";
            colorClass = "text-rose-400";
          }
          return (
            <div className="space-y-6 text-center">
              <div className="rounded-3xl bg-white p-6 shadow">
                <div className={`text-2xl font-extrabold ${colorClass}`}>{message}</div>
                <div className="mt-2 text-lg">Score: {testScore.correct} / {testScore.total}</div>
                <div className="mt-1 text-slate-600">That's {percentage}%</div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <button onClick={startTest} className="rounded-2xl bg-amber-500 px-4 py-4 text-white font-semibold shadow active:scale-95">Try Test Again</button>
                {activeDeck && (
                  <button onClick={()=>setScreen("practice")} className="rounded-2xl bg-emerald-500 px-4 py-4 text-white font-semibold shadow active:scale-95">Go to Practice</button>
                )}
                <button onClick={()=>setScreen("mode")} className="rounded-2xl bg-white px-4 py-4 font-semibold shadow active:scale-95">Back to Deck</button>
              </div>
            </div>
          );
        })()}

        {screen === "editor" && draftDeck && (
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="text-sm font-semibold text-slate-600">Editing Deck</div>
              <input
                className="w-full rounded-xl border-2 border-slate-200 px-4 py-3 text-xl font-bold focus:border-amber-400 focus:outline-none"
                value={draftDeck.name}
                onChange={(e)=>setDraftDeck({ ...draftDeck, name: e.target.value })}
                placeholder="Deck name"
              />
              <div className="flex flex-wrap gap-3">
                <button onClick={saveDraft} className="rounded-xl bg-emerald-500 px-6 py-3 font-semibold text-white shadow active:scale-95">Save changes</button>
                <button onClick={discardDraft} className="rounded-xl bg-white border-2 border-slate-300 px-6 py-3 font-semibold shadow active:scale-95">Discard</button>
                {!isNewDeck && (
                  <button onClick={()=>deleteDeck(draftDeck.id)} className="rounded-xl bg-white border-2 border-slate-300 px-6 py-3 text-rose-600 shadow active:scale-95 flex items-center gap-2 font-semibold"><Trash2 size={18}/> Delete</button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {draftDeck.cards.length === 0 && (
                <div className="col-span-full rounded-2xl bg-white p-4 text-center text-sm text-slate-500 shadow">No cards yet — add some!</div>
              )}

              {draftDeck.cards.map((c, i) => {
                const isExpanded = expandedCards.has(c.id);
                return (
                  <div key={c.id} className="rounded-2xl bg-white p-5 shadow">
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-lg font-semibold text-slate-800">Card {i+1}</div>
                        <button 
                          onClick={()=>toggleCardExpansion(c.id)}
                          className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50 active:scale-95 transition"
                          title={isExpanded ? "Collapse" : "Expand for Back, Hint, Remove"}
                        >
                          {isExpanded ? <ChevronUp size={18} className="text-slate-600"/> : <ChevronDown size={18} className="text-slate-600"/>}
                        </button>
                      </div>
                      <input
                        ref={(el) => {
                          if (el) frontRefs.current.set(c.id, el);
                          else frontRefs.current.delete(c.id);
                        }}
                        className="w-full rounded-lg border-2 border-slate-200 px-4 py-3 text-base focus:border-amber-400 focus:outline-none"
                        value={c.front}
                        onChange={(e)=>onFrontChange(c.id, e.target.value)}
                        placeholder="Front (required)"
                      />
                    </div>
                    
                    {isExpanded && (
                      <div className="space-y-4 pt-4 border-t-2 border-slate-200">
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1.5">Back (optional)</label>
                          <input
                            className="w-full rounded-lg border-2 border-slate-200 px-4 py-2.5 text-base focus:border-amber-400 focus:outline-none"
                            value={c.back || ""}
                            onChange={(e)=>updateDraftCard(c.id, { back: e.target.value })}
                            placeholder="Back text"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1.5">Hint (optional)</label>
                          <input
                            className="w-full rounded-lg border-2 border-slate-200 px-4 py-2.5 text-base focus:border-amber-400 focus:outline-none"
                            value={c.hint || ""}
                            onChange={(e)=>updateDraftCard(c.id, { hint: e.target.value })}
                            placeholder="Hint text"
                          />
                        </div>
                        <button onClick={()=>removeDraftCard(c.id)} className="w-full rounded-lg border-2 border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-100 active:scale-95 transition flex items-center justify-center gap-2">
                          <Trash2 size={16}/> Remove Card
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex gap-3">
              <button onClick={saveDraft} className="flex-1 rounded-2xl bg-emerald-500 px-4 py-3 font-semibold text-white shadow active:scale-95">Save changes</button>
              <button onClick={addDraftCard} className="flex items-center justify-center gap-2 rounded-2xl bg-amber-500 px-4 py-3 text-white shadow active:scale-95">
                <Plus size={18}/> Add Card
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom safe area */}
      <div className="h-12"/>
    </div>
  );
}
