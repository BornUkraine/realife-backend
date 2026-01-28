import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";

const app = express();

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json());

/* =========================
   MULTER (memory)
========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Realife backend",
    message: "Backend is running"
  });
});

/* =========================
   UPLOAD → IPFS (PINATA)
========================= */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: "error",
        message: "No file uploaded"
      });
    }

    if (!process.env.PINATA_JWT) {
      return res.status(500).json({
        status: "error",
        message: "PINATA_JWT is missing"
      });
    }

    const formData = new FormData();
    formData.append("file", req.file.buffer, req.file.originalname);

    const pinataResponse = await axios.post(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      formData,
      {
        maxBodyLength: Infinity,
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${process.env.PINATA_JWT}`
        }
      }
    );

    const cid = pinataResponse.data.IpfsHash;

    res.json({
      status: "ok",
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      cid,
      ipfs: `ipfs://${cid}`,
      gateway: `https://gateway.pinata.cloud/ipfs/${cid}`
    });

  } catch (error) {
    console.error("UPLOAD ERROR:", error.response?.data || error.message);

    res.status(500).json({
      status: "error",
      message: "Upload to IPFS failed"
    });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Realife backend running on port ${PORT}`);
});
