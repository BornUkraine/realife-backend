import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { createPublicClient, http, parseAbiItem, zeroAddress } from "viem";
import { baseSepolia } from "viem/chains";

// ✅ auto-poster (server-side)
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";

// ✅ robust ESM import for ffmpeg-static
const ffmpegPath =
  typeof ffmpegStatic === "string" ? ffmpegStatic : (ffmpegStatic?.default ?? null);

/* =========================
   ABI (READ-ONLY)
========================= */

// ERC-721 (your existing contract)
const ABI_721 = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
];

// ERC-1155 (Editions contract)
const ABI_1155 = [
  {
    type: "function",
    name: "uri",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
];

/* =========================
   IPFS GATEWAY (for reading)
========================= */
const IPFS_GATEWAY_ORIGIN = (process.env.IPFS_GATEWAY_ORIGIN || "https://nftstorage.link").replace(
  /\/$/,
  ""
);

function ipfsToHttp(uri) {
  const u = String(uri || "").trim();
  if (!u) return "";

  if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("data:") || u.startsWith("blob:"))
    return u;

  if (u.startsWith("ipfs://")) {
    let p = u.slice("ipfs://".length);
    if (p.startsWith("ipfs/")) p = p.slice("ipfs/".length);
    return `${IPFS_GATEWAY_ORIGIN}/ipfs/${p}`;
  }

  if (u.startsWith("/ipfs/")) return `${IPFS_GATEWAY_ORIGIN}${u}`;
  if (u.startsWith("Qm") || u.startsWith("bafy")) return `${IPFS_GATEWAY_ORIGIN}/ipfs/${u}`;

  return u;
}

async function headContentType(url) {
  try {
    const r = await axios.head(url, {
      timeout: 12_000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    return String(r.headers?.["content-type"] || "").toLowerCase();
  } catch {
    return "";
  }
}

/* =========================
   AUTO-POSTER HELPERS (ffmpeg)
   ✅ Install in backend:
      npm i ffmpeg-static
   ✅ Optional env fallback:
      DEFAULT_VIDEO_POSTER = ipfs://<CID>   (must be IMAGE)
========================= */
async function runFfmpeg(args) {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found (ffmpeg-static)");
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (${code}): ${err || "unknown"}`));
    });
  });
}

async function makePosterFromVideo(videoBuffer) {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found (ffmpeg-static)");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rl-"));
  const inPath = path.join(dir, "in.mp4");
  const outPath = path.join(dir, "poster.jpg");

  try {
    await fs.writeFile(inPath, videoBuffer);

    // try 1.0s, then fallback 0.1s
    const tries = ["00:00:01.000", "00:00:00.100"];
    let lastErr = null;

    for (const ss of tries) {
      try {
        await runFfmpeg([
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          ss,
          "-i",
          inPath,
          "-frames:v",
          "1",
          "-q:v",
          "2",
          outPath,
        ]);
        return await fs.readFile(outPath);
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("Failed to extract poster frame");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* =========================
   BLOCKCHAIN CLIENT
========================= */
if (!process.env.RPC_URL) {
  throw new Error("RPC_URL is missing");
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.RPC_URL),
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
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "Realife backend", message: "Backend is running" });
});

/* =========================
   HELPERS: Pinata upload
========================= */
async function pinFileToIpfs(buffer, filename, jwt) {
  const fileForm = new FormData();
  fileForm.append("file", buffer, filename);

  const r = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", fileForm, {
    maxBodyLength: Infinity,
    headers: {
      ...fileForm.getHeaders(),
      Authorization: `Bearer ${jwt}`,
    },
  });

  const cid = r.data?.IpfsHash;
  if (!cid) throw new Error("Pinata pinFileToIPFS: missing IpfsHash");
  return `ipfs://${cid}`;
}

/* =========================
   MINT PREPARE (UPLOAD + METADATA)
========================= */
app.post(
  "/api/mint/prepare",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "poster", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, description, category, project, supply, proofUrl } = req.body;

      const fileArr = req.files?.file || [];
      const posterArr = req.files?.poster || [];
      const file = fileArr[0] || null;
      const posterFile = posterArr[0] || null;

      if (!name || !file) {
        return res.status(400).json({ status: "error", message: "Name and file are required" });
      }
      if (!process.env.PINATA_JWT) {
        return res.status(500).json({ status: "error", message: "PINATA_JWT is missing" });
      }

      const isVideo = String(file.mimetype || "").startsWith("video/");
      const isPosterOk = posterFile ? String(posterFile.mimetype || "").startsWith("image/") : false;

      if (posterFile && !isPosterOk) {
        return res.status(400).json({ status: "error", message: "Poster must be an image file" });
      }

      /* ========= 1️⃣ Upload main file ========= */
      const mediaUri = await pinFileToIpfs(file.buffer, file.originalname || "media", process.env.PINATA_JWT);

      /* ========= 2️⃣ Poster logic (video) ========= */
      let posterUri = null;

      if (isVideo) {
        if (posterFile && isPosterOk) {
          posterUri = await pinFileToIpfs(
            posterFile.buffer,
            posterFile.originalname || "poster",
            process.env.PINATA_JWT
          );
        } else {
          try {
            const posterBuf = await makePosterFromVideo(file.buffer);
            posterUri = await pinFileToIpfs(posterBuf, "poster.jpg", process.env.PINATA_JWT);
          } catch {
            posterUri = process.env.DEFAULT_VIDEO_POSTER || null;
          }
        }

        if (!posterUri) {
          return res.status(400).json({
            status: "error",
            message:
              "Poster required for video. Upload poster image or set DEFAULT_VIDEO_POSTER env (ipfs://...).",
          });
        }
      }

      /* ========= 3️⃣ Build METADATA ========= */
      const metadata = {
        name: String(name).trim(),
        description: (description || "").trim(),
        category: (category || "Other").trim(),
        project: (project || "Realife").trim(),
        supply: Number(supply) || 1,
        proof: (proofUrl || "").trim() || null,
        attributes: [],
      };

      if (isVideo) {
        metadata.animation_url = mediaUri;
        metadata.image = posterUri; // ✅ always image
      } else {
        metadata.image = mediaUri;
      }

      /* ========= 4️⃣ Upload METADATA ========= */
      const metadataUpload = await axios.post("https://api.pinata.cloud/pinning/pinJSONToIPFS", metadata, {
        headers: {
          Authorization: `Bearer ${process.env.PINATA_JWT}`,
          "Content-Type": "application/json",
        },
      });

      const metadataCid = metadataUpload.data?.IpfsHash;
      if (!metadataCid) throw new Error("Pinata pinJSONToIPFS: missing IpfsHash");
      const metadataUri = `ipfs://${metadataCid}`;

      /* ========= 5️⃣ RESPONSE ========= */
      return res.json({
        status: "ready",
        metadataUri,
        tokenURI: metadataUri,
        preview: {
          name: metadata.name,
          category: metadata.category,
          kind: isVideo ? "video" : "image",
          media: isVideo ? metadata.animation_url : metadata.image,
          poster: isVideo ? metadata.image : null,
          image: metadata.image,
        },
      });
    } catch (err) {
      console.error("MINT PREPARE ERROR:", err?.message || err);
      return res.status(500).json({ status: "error", message: "Mint preparation failed" });
    }
  }
);

/* =========================
   DYNAMIC NFT METADATA (ERC-721) (v1.3)
========================= */
app.get("/metadata/:tokenId", async (req, res) => {
  try {
    res.set({ "Cache-Control": "public, max-age=60, s-maxage=60, must-revalidate" });

    let tokenId;
    try {
      tokenId = BigInt(req.params.tokenId);
    } catch {
      return res.status(400).json({ status: "error", message: "Invalid tokenId" });
    }

    const contract = process.env.REALIFE_CONTRACT;
    if (!contract) {
      return res.status(500).json({ status: "error", message: "REALIFE_CONTRACT is missing" });
    }

    /* ========= 1️⃣ SAFE ownerOf ========= */
    let owner;
    try {
      owner = await client.readContract({
        address: contract,
        abi: ABI_721,
        functionName: "ownerOf",
        args: [tokenId],
      });
    } catch {
      return res.json({
        name: `Realife #${tokenId}`,
        description: "Unminted Realife NFT",
        image: null,
        animation_url: null,
        attributes: [{ trait_type: "Status", value: "Not minted" }],
      });
    }

    /* ========= 2️⃣ tokenURI → ORIGINAL METADATA ========= */
    let name = `Realife #${tokenId}`;
    let description = "Real-life work tokenized on Realife";
    let image = null;
    let animation_url = null;
    let originalAttributes = [];
    let category = null;
    let project = null;

    try {
      const tokenUri = await client.readContract({
        address: contract,
        abi: ABI_721,
        functionName: "tokenURI",
        args: [tokenId],
      });

      if (tokenUri) {
        const metadataUrl = ipfsToHttp(tokenUri);
        const originalMetadata = await axios.get(metadataUrl, { timeout: 12_000 });

        name = originalMetadata.data?.name ?? name;
        description = originalMetadata.data?.description ?? description;

        image = originalMetadata.data?.image ?? image;
        animation_url =
          originalMetadata.data?.animation_url ??
          originalMetadata.data?.animationUrl ??
          originalMetadata.data?.animation ??
          null;

        category = originalMetadata.data?.category ?? null;
        project = originalMetadata.data?.project ?? null;

        originalAttributes = Array.isArray(originalMetadata.data?.attributes)
          ? originalMetadata.data.attributes
          : [];

        // fallback for old "video in image"
        if (!animation_url && image) {
          const ct = await headContentType(ipfsToHttp(image));
          if (ct.startsWith("video/")) animation_url = image;
        }

        // if image equals animation_url, hide image to avoid broken <img>
        if (image && animation_url && String(image).trim() === String(animation_url).trim()) {
          image = null;
        }
      }
    } catch {
      console.warn("Metadata fetch failed, fallback used");
    }

    /* ========= 3️⃣ balanceOf ========= */
    const balance = await client.readContract({
      address: contract,
      abi: ABI_721,
      functionName: "balanceOf",
      args: [owner],
    });

    /* ========= 4️⃣ reputation score ========= */
    const reputationScore = Math.min(Number(balance), 100);

    /* ========= 5️⃣ block timestamp ========= */
    const block = await client.getBlock();

    /* ========= 6️⃣ ATTRIBUTES ========= */
    const attributes = [
      ...(category ? [{ trait_type: "Category", value: category }] : []),
      ...(project ? [{ trait_type: "Project", value: project }] : []),
      ...originalAttributes,
      { trait_type: "Owner", value: owner },
      { trait_type: "Owned NFTs", value: balance.toString() },
      { trait_type: "Last Updated", value: new Date(Number(block.timestamp) * 1000).toISOString() },
      { trait_type: "Reputation Score", value: reputationScore, display_type: "number" },
    ];

    if (balance >= 3n) attributes.push({ trait_type: "Verified Creator", value: "Yes" });
    if (balance >= 5n) attributes.push({ trait_type: "Reputation", value: "High" });
    else if (balance >= 2n) attributes.push({ trait_type: "Reputation", value: "Medium" });
    else attributes.push({ trait_type: "Reputation", value: "New" });

    const imageHttp = image ? ipfsToHttp(image) : null;
    const animHttp = animation_url ? ipfsToHttp(animation_url) : null;

    return res.json({
      name,
      description,
      image: imageHttp,
      animation_url: animHttp,
      attributes,
    });
  } catch (err) {
    console.error("ONCHAIN METADATA ERROR:", err);
    return res.status(500).json({ status: "error" });
  }
});

/* =========================
   DYNAMIC NFT METADATA (ERC-1155) (v1.0)
   GET /metadata1155/:tokenId
   - reads uri(id)
   - reads totalSupply(id)
   - optional: tries to find creator via TransferSingle(from=0x0)
========================= */
app.get("/metadata1155/:tokenId", async (req, res) => {
  try {
    res.set({ "Cache-Control": "public, max-age=60, s-maxage=60, must-revalidate" });

    let tokenId;
    try {
      tokenId = BigInt(req.params.tokenId);
    } catch {
      return res.status(400).json({ status: "error", message: "Invalid tokenId" });
    }

    const contract1155 = process.env.REALIFE_1155_CONTRACT;
    if (!contract1155) {
      return res.status(500).json({ status: "error", message: "REALIFE_1155_CONTRACT is missing" });
    }

    // 1) uri(id)
    let tokenUri = "";
    try {
      tokenUri = await client.readContract({
        address: contract1155,
        abi: ABI_1155,
        functionName: "uri",
        args: [tokenId],
      });
    } catch {
      tokenUri = "";
    }

    // 2) totalSupply(id)
    let totalSupply = 0n;
    try {
      totalSupply = await client.readContract({
        address: contract1155,
        abi: ABI_1155,
        functionName: "totalSupply",
        args: [tokenId],
      });
    } catch {
      totalSupply = 0n;
    }

    // 3) fetch original metadata JSON from uri
    let name = `Realife Edition #${tokenId}`;
    let description = "Real-life edition tokenized on Realife";
    let image = null;
    let animation_url = null;
    let originalAttributes = [];
    let category = null;
    let project = null;

    if (tokenUri) {
      try {
        const metadataUrl = ipfsToHttp(tokenUri);
        const originalMetadata = await axios.get(metadataUrl, { timeout: 12_000 });

        name = originalMetadata.data?.name ?? name;
        description = originalMetadata.data?.description ?? description;

        image = originalMetadata.data?.image ?? image;
        animation_url =
          originalMetadata.data?.animation_url ??
          originalMetadata.data?.animationUrl ??
          originalMetadata.data?.animation ??
          null;

        category = originalMetadata.data?.category ?? null;
        project = originalMetadata.data?.project ?? null;

        originalAttributes = Array.isArray(originalMetadata.data?.attributes)
          ? originalMetadata.data.attributes
          : [];

        // fallback: if no animation_url but image is a video
        if (!animation_url && image) {
          const ct = await headContentType(ipfsToHttp(image));
          if (ct.startsWith("video/")) animation_url = image;
        }

        // if image equals animation_url, hide image to avoid broken <img>
        if (image && animation_url && String(image).trim() === String(animation_url).trim()) {
          image = null;
        }
      } catch {
        // ignore
      }
    }

    // 4) optional: try to find creator via TransferSingle mint
    let creator = null;
    try {
      const latest = await client.getBlockNumber();
      const fromBlock = latest > 200000n ? latest - 200000n : 0n;

      const transferSingleEvent = parseAbiItem(
        "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"
      );

      const logs = await client.getLogs({
        address: contract1155,
        event: transferSingleEvent,
        args: { id: tokenId },
        fromBlock,
        toBlock: latest,
      });

      const mintLog = logs.find((l) => (l.args?.from || "").toLowerCase() === zeroAddress.toLowerCase());
      if (mintLog?.args?.to) creator = mintLog.args.to;
    } catch {
      creator = null;
    }

    const block = await client.getBlock();

    const imageHttp = image ? ipfsToHttp(image) : null;
    const animHttp = animation_url ? ipfsToHttp(animation_url) : null;

    const attributes = [
      { trait_type: "Standard", value: "ERC1155" },
      { trait_type: "Token ID", value: tokenId.toString() },
      { trait_type: "Total Supply", value: totalSupply.toString() },
      ...(creator ? [{ trait_type: "Creator", value: creator }] : []),
      ...(category ? [{ trait_type: "Category", value: category }] : []),
      ...(project ? [{ trait_type: "Project", value: project }] : []),
      ...originalAttributes,
      { trait_type: "Contract", value: contract1155 },
      { trait_type: "Last Updated", value: new Date(Number(block.timestamp) * 1000).toISOString() },
    ];

    return res.json({
      name,
      description,
      image: imageHttp,
      animation_url: animHttp,
      attributes,
    });
  } catch (err) {
    console.error("METADATA1155 ERROR:", err);
    return res.status(500).json({ status: "error" });
  }
});

/* =========================
   START SERVER (ALWAYS LAST)
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Realife backend running on port ${PORT}`);
});