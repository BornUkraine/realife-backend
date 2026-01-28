import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());

// ⚠️ ВАЖНО: memoryStorage
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

// ✅ UPLOAD ENDPOINT (КЛЮЧЕВОЕ)
app.post(
  "/upload",
  upload.single("file"), // 👈 ИМЯ ПОЛЯ = file
  (req, res) => {
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
      console.error(err);
      res.status(500).json({
        status: "error",
        message: "Server error"
      });
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Realife backend running on port ${PORT}`);
});
