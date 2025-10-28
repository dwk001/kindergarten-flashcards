const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// Serve uploaded images
app.use('/uploads', express.static(uploadsDir));

// Upload endpoint
app.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided' });
  }

  try {
    // Generate unique filename
    const filename = `cast_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const filepath = path.join(uploadsDir, filename);

    // Save file to disk
    fs.writeFileSync(filepath, req.file.buffer);

    // Return URL (adjust this to your server's actual URL)
    const imageUrl = `http://192.168.1.112:8086/uploads/${filename}`;
    
    res.json({ url: imageUrl });
  } catch (error) {
    console.error('Error saving image:', error);
    res.status(500).json({ error: 'Failed to save image' });
  }
});

const PORT = 8087;
app.listen(PORT, () => {
  console.log(`Image upload server running on port ${PORT}`);
});

