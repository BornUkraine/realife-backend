import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json());

// Multer: сохраняем файл в память (RAM)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50 MB
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

// 🔥 POST /upload — PHASE 1
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      status: "error",
      message: "No file uploaded"
    });
  }

  res.json({
    status: "success",
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    message: "File uploaded successfully (stored in memory)"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Realife backend running on port ${PORT}`);
});
