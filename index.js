import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json());

// Multer config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Realife backend",
    message: "Backend is running"
  });
});

// UPLOAD endpoint
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: "error",
        message: "No file uploaded"
      });
    }

    res.json({
      status: "ok",
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({
      status: "error",
      message: "Upload failed"
    });
  }
});

// GLOBAL error handler (ВАЖНО)
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);
  res.status(500).json({
    status: "error",
    message: "Server error"
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Realife backend running on port ${PORT}`);
});
