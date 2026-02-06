import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

/* =========================
   ABI (READ-ONLY)
========================= */
const ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }]
  }
];

/* =========================
   BLOCKCHAIN CLIENT
========================= */
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.RPC_URL)
});

const app = express();

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json());


/* =========================
   MULTER (memory storage)
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
   METADATA → IPFS (PINATA)
========================= */
app.post("/metadata", async (req, res) => {
  try {
    const { name, description, image, attributes } = req.body;

    if (!name || !image) {
      return res.status(400).json({
        status: "error",
        message: "name and image are required"
      });
    }

    if (!process.env.PINATA_JWT) {
      return res.status(500).json({
        status: "error",
        message: "PINATA_JWT is missing"
      });
    }

    const metadata = {
      name,
      description: description || "",
      image,
      attributes: attributes || []
    };

    const pinataResponse = await axios.post(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      metadata,
      {
        headers: {
          Authorization: `Bearer ${process.env.PINATA_JWT}`,
          "Content-Type": "application/json"
        }
      }
    );

    const cid = pinataResponse.data.IpfsHash;

    res.json({
      status: "ok",
      cid,
      tokenURI: `ipfs://${cid}`,
      gateway: `https://gateway.pinata.cloud/ipfs/${cid}`,
      metadata
    });

  } catch (error) {
    console.error("METADATA ERROR:", error.response?.data || error.message);

    res.status(500).json({
      status: "error",
      message: "Metadata upload failed"
    });
  }
});

/* =========================
   DYNAMIC NFT METADATA (ONCHAIN)
========================= */
app.get("/metadata/:tokenId", async (req, res) => {
  try {
    const tokenId = BigInt(req.params.tokenId);
    const contract = process.env.REALIFE_CONTRACT;

    // 1️⃣ ownerOf
    const owner = await client.readContract({
      address: contract,
      abi: ABI,
      functionName: "ownerOf",
      args: [tokenId]
    });

    // 2️⃣ balanceOf
    const balance = await client.readContract({
      address: contract,
      abi: ABI,
      functionName: "balanceOf",
      args: [owner]
    });

    // 3️⃣ latest block
    const block = await client.getBlock();

    const attributes = [
      { trait_type: "Platform", value: "Realife" },
      { trait_type: "Token ID", value: tokenId.toString() },
      { trait_type: "Owner", value: owner },
      { trait_type: "Owned NFTs", value: balance.toString() },
      {
        trait_type: "Last Updated",
        value: new Date(Number(block.timestamp) * 1000).toISOString()
      }
    ];

    // 🟢 Verified Creator
    if (balance >= 3n) {
      attributes.push({
        trait_type: "Verified Creator",
        value: "Yes"
      });
    }

    // 🟣 Reputation tier
    if (balance >= 5n) {
      attributes.push({ trait_type: "Reputation", value: "High" });
    } else if (balance >= 2n) {
      attributes.push({ trait_type: "Reputation", value: "Medium" });
    } else {
      attributes.push({ trait_type: "Reputation", value: "New" });
    }

    res.json({
      name: `Realife #${tokenId}`,
      description: "Real-life work tokenized on Realife",
      image: "ipfs://QmZCppQHC9u1fsWrLk4D2hVJz1hFJwbToqPwwC96auRVR",
      attributes
    });

  } catch (err) {
    console.error("ONCHAIN METADATA ERROR:", err);
    res.status(500).json({ status: "error" });
  }
});


/* =========================
   START SERVER (ALWAYS LAST)
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Realife backend running on port ${PORT}`);
});