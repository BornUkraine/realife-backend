import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// ✅ auto-poster (server-side)
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";

// ✅ robust ESM import for ffmpeg-static
const ffmpegPath =
  typeof ffmpegStatic === "string"
    ? ffmpegStatic
    : ffmpegStatic?.default ?? null;

/* =========================
   HELPERS
========================= */
function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function isAddressLike(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || "").trim());
}

function isNonZeroAddress(v) {
  const s = norm(v);
  return isAddressLike(s) && s !== "0x0000000000000000000000000000000000000000";
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((v) => norm(v)).filter(Boolean)));
}

function cleanString(v, max = 2000) {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : "";
}

function addAttr(attributes, traitType, value) {
  const trait = cleanString(traitType, 120);
  const val = cleanString(value, 500);
  if (!trait || !val) return;
  attributes.push({ trait_type: trait, value: val });
}

function resolveContractAlias(raw) {
  const v = norm(raw);
  if (!v) return "";

  if (v === "standard" || v === "default" || v === "main") {
    return REALIFE_1155_STANDARD_CONTRACT || "";
  }

  if (v === "delivery") {
    return REALIFE_1155_DELIVERY_CONTRACT || "";
  }

  if (isAddressLike(v)) return norm(v);
  return "";
}

const FULFILLMENT_TYPES = new Set([
  "PHYSICAL_GOOD",
  "DIGITAL_SERVICE",
  "ONLINE_SESSION",
  "LOCAL_SERVICE",
]);

function normalizeFulfillmentType(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  if (FULFILLMENT_TYPES.has(s)) return s;
  return null;
}

function computeProtectedFields({
  fulfillmentType,
  deliveryMode,
  deliveryEnabled,
  physicalItemIncluded,
}) {
  const explicitFulfillmentType = normalizeFulfillmentType(fulfillmentType);

  const safeDeliveryMode =
    String(deliveryMode || "").trim().toLowerCase() === "delivery"
      ? "delivery"
      : "none";

  const hasPhysicalSignal =
    explicitFulfillmentType === "PHYSICAL_GOOD" ||
    safeDeliveryMode === "delivery" ||
    toBool(deliveryEnabled) ||
    toBool(physicalItemIncluded);

  const finalFulfillmentType =
    explicitFulfillmentType || (hasPhysicalSignal ? "PHYSICAL_GOOD" : null);

  const finalDeliveryEnabled =
    finalFulfillmentType === "PHYSICAL_GOOD"
      ? true
      : toBool(deliveryEnabled);

  const finalPhysicalItemIncluded =
    finalFulfillmentType === "PHYSICAL_GOOD"
      ? true
      : toBool(physicalItemIncluded);

  const suggestedMarketType = finalFulfillmentType ? "PROTECTED" : "STANDARD";
  const requiresProtectedMarket = suggestedMarketType === "PROTECTED";

  return {
    finalFulfillmentType,
    finalDeliveryEnabled,
    finalPhysicalItemIncluded,
    suggestedMarketType,
    requiresProtectedMarket,
    safeDeliveryMode,
  };
}

/* =========================
   ABI (READ-ONLY) — 1155 ONLY
   Works for:
   - Realife1155New
   - Realife1155Delivery
========================= */
const ABI_1155_READ = [
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
  {
    type: "function",
    name: "maxSupply",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "creatorOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
];

/* =========================
   IPFS GATEWAY (for reading)
========================= */
const IPFS_GATEWAY_ORIGIN = (
  process.env.IPFS_GATEWAY_ORIGIN || "https://nftstorage.link"
).replace(/\/$/, "");

function ipfsToHttp(uri) {
  const u = String(uri || "").trim();
  if (!u) return "";

  if (
    u.startsWith("http://") ||
    u.startsWith("https://") ||
    u.startsWith("data:") ||
    u.startsWith("blob:")
  ) {
    return u;
  }

  if (u.startsWith("ipfs://")) {
    let p = u.slice("ipfs://".length);
    if (p.startsWith("ipfs/")) p = p.slice("ipfs/".length);
    return `${IPFS_GATEWAY_ORIGIN}/ipfs/${p}`;
  }

  if (u.startsWith("/ipfs/")) return `${IPFS_GATEWAY_ORIGIN}${u}`;
  if (u.startsWith("Qm") || u.startsWith("bafy")) {
    return `${IPFS_GATEWAY_ORIGIN}/ipfs/${u}`;
  }

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

    p.stderr.on("data", (d) => {
      err += d.toString();
    });

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
const RPC_URL =
  process.env.RPC_URL ||
  process.env.BASE_SEPOLIA_RPC ||
  "https://sepolia.base.org";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

/* =========================
   KNOWN USER 1155 CONTRACTS
========================= */
const REALIFE_1155_STANDARD_CONTRACT = norm(
  process.env.REALIFE_1155_NEW_CONTRACT ||
    process.env.NEXT_PUBLIC_REALIFE_1155_NEW_CONTRACT ||
    ""
);

const REALIFE_1155_DELIVERY_CONTRACT = norm(
  process.env.REALIFE_1155_DELIVERY_CONTRACT ||
    process.env.NEXT_PUBLIC_REALIFE_1155_DELIVERY_CONTRACT ||
    ""
);

const REALIFE_PROTECTED_MARKETPLACE_CONTRACT = norm(
  process.env.REALIFE_PROTECTED_MARKETPLACE_CONTRACT ||
    process.env.NEXT_PUBLIC_REALIFE_PROTECTED_MARKETPLACE_CONTRACT ||
    process.env.PROTECTED_MARKETPLACE_ADDRESS ||
    ""
);

const KNOWN_1155_CONTRACTS = uniqueStrings([
  REALIFE_1155_STANDARD_CONTRACT,
  REALIFE_1155_DELIVERY_CONTRACT,
]);

async function readContractSafe(address, functionName, args, fallback = null) {
  try {
    return await client.readContract({
      address,
      abi: ABI_1155_READ,
      functionName,
      args,
    });
  } catch {
    return fallback;
  }
}

async function probe1155Token(contractAddress, tokenId) {
  const totalSupply = await readContractSafe(
    contractAddress,
    "totalSupply",
    [tokenId],
    0n
  );

  const maxSupply = await readContractSafe(
    contractAddress,
    "maxSupply",
    [tokenId],
    0n
  );

  const creatorRaw = await readContractSafe(
    contractAddress,
    "creatorOf",
    [tokenId],
    null
  );

  const uri = await readContractSafe(contractAddress, "uri", [tokenId], "");

  const creator = creatorRaw ? String(creatorRaw) : null;

  const exists =
    BigInt(totalSupply || 0n) > 0n ||
    BigInt(maxSupply || 0n) > 0n ||
    isNonZeroAddress(creator);

  return {
    contract: norm(contractAddress),
    uri: String(uri || "").trim(),
    totalSupply: totalSupply ?? 0n,
    maxSupply: maxSupply ?? 0n,
    creator,
    exists,
  };
}

async function resolve1155ContractForToken(tokenId, preferredContractRaw = "") {
  const preferred = resolveContractAlias(preferredContractRaw);

  if (preferred && isAddressLike(preferred)) {
    return preferred;
  }

  if (KNOWN_1155_CONTRACTS.length === 0) {
    return "";
  }

  if (KNOWN_1155_CONTRACTS.length === 1) {
    return KNOWN_1155_CONTRACTS[0];
  }

  const candidates = uniqueStrings([
    REALIFE_1155_STANDARD_CONTRACT,
    REALIFE_1155_DELIVERY_CONTRACT,
  ]);

  for (const c of candidates) {
    if (!c) continue;
    const probe = await probe1155Token(c, tokenId);
    if (probe.exists) return c;
  }

  return REALIFE_1155_STANDARD_CONTRACT || REALIFE_1155_DELIVERY_CONTRACT || "";
}

async function build1155MetadataResponse(contract1155, tokenId) {
  let tokenUri = "";
  try {
    tokenUri = await client.readContract({
      address: contract1155,
      abi: ABI_1155_READ,
      functionName: "uri",
      args: [tokenId],
    });
  } catch {
    tokenUri = "";
  }

  let totalSupply = 0n;
  try {
    totalSupply = await client.readContract({
      address: contract1155,
      abi: ABI_1155_READ,
      functionName: "totalSupply",
      args: [tokenId],
    });
  } catch {
    totalSupply = 0n;
  }

  let max = 0n;
  try {
    max = await client.readContract({
      address: contract1155,
      abi: ABI_1155_READ,
      functionName: "maxSupply",
      args: [tokenId],
    });
  } catch {
    max = 0n;
  }

  let creator = null;
  try {
    const c = await client.readContract({
      address: contract1155,
      abi: ABI_1155_READ,
      functionName: "creatorOf",
      args: [tokenId],
    });
    creator = c ? String(c) : null;
  } catch {
    creator = null;
  }

  let name = `Realife Edition #${tokenId}`;
  let description = "Real-life tokenized on Realife";
  let image = null;
  let animation_url = null;
  let originalAttributes = [];

  let category = null;
  let subcategory = null;
  let project = null;
  let collection = null;
  let item = null;
  let itemType = null;
  let rarity = null;
  let brandProject = null;
  let brand = null;
  let vertical = null;
  let proof = null;
  let external_url = null;

  let deliveryMode = "none";
  let deliveryEnabled = false;
  let physicalItemIncluded = false;
  let officialItem = false;
  let fulfillmentType = null;
  let suggestedMarketType = null;
  let requiresProtectedMarket = false;

  if (tokenUri) {
    try {
      const metadataUrl = ipfsToHttp(tokenUri);
      const originalMetadata = await axios.get(metadataUrl, { timeout: 12_000 });
      const data = originalMetadata.data || {};

      name = data?.name ?? name;
      description = data?.description ?? description;

      image = data?.image ?? image;
      animation_url =
        data?.animation_url ??
        data?.animationUrl ??
        data?.animation ??
        null;

      category = data?.category ?? null;
      subcategory = data?.subcategory ?? null;
      project = data?.project ?? null;
      collection = data?.collection ?? null;
      item = data?.item ?? null;
      itemType = data?.itemType ?? null;
      rarity = data?.rarity ?? null;
      brandProject = data?.brandProject ?? null;
      brand = data?.brand ?? null;
      vertical = data?.vertical ?? null;
      proof = data?.proof ?? null;
      external_url = data?.external_url ?? null;

      const protectedFields = computeProtectedFields({
        fulfillmentType: data?.fulfillmentType,
        deliveryMode: data?.deliveryMode,
        deliveryEnabled: data?.deliveryEnabled,
        physicalItemIncluded: data?.physicalItemIncluded,
      });

      deliveryMode = protectedFields.safeDeliveryMode;
      deliveryEnabled = protectedFields.finalDeliveryEnabled;
      physicalItemIncluded = protectedFields.finalPhysicalItemIncluded;
      fulfillmentType = protectedFields.finalFulfillmentType;
      requiresProtectedMarket = protectedFields.requiresProtectedMarket;

      officialItem = toBool(data?.officialItem);

      const rawSuggestedMarketType = String(
        data?.suggestedMarketType || ""
      ).trim().toUpperCase();

      suggestedMarketType =
        rawSuggestedMarketType === "PROTECTED" ||
        rawSuggestedMarketType === "STANDARD"
          ? rawSuggestedMarketType
          : protectedFields.suggestedMarketType;

      requiresProtectedMarket = suggestedMarketType === "PROTECTED";

      originalAttributes = Array.isArray(data?.attributes)
        ? data.attributes
        : [];

      if (!animation_url && image) {
        const ct = await headContentType(ipfsToHttp(image));
        if (ct.startsWith("video/")) animation_url = image;
      }

      if (
        image &&
        animation_url &&
        String(image).trim() === String(animation_url).trim()
      ) {
        image = null;
      }
    } catch {
      //
    }
  }

  const block = await client.getBlock();

  const imageHttp = image ? ipfsToHttp(image) : null;
  const animHttp = animation_url ? ipfsToHttp(animation_url) : null;

  const isUnique = max === 1n;
  const attributes = [];

  addAttr(attributes, "Standard", "ERC1155");
  addAttr(attributes, "Token ID", tokenId.toString());
  addAttr(attributes, "Total Supply", totalSupply.toString());

  if (max > 0n) addAttr(attributes, "Max Supply", max.toString());
  if (creator) addAttr(attributes, "Creator", creator);
  if (category) addAttr(attributes, "Category", category);
  if (subcategory) addAttr(attributes, "Subcategory", subcategory);
  if (project) addAttr(attributes, "Project", project);
  if (brandProject) addAttr(attributes, "Brand Project", brandProject);
  if (brand) addAttr(attributes, "Brand", brand);
  if (collection) addAttr(attributes, "Collection", collection);
  if (item) addAttr(attributes, "Item", item);
  if (itemType) addAttr(attributes, "Item Type", itemType);
  if (rarity) addAttr(attributes, "Rarity", rarity);
  if (vertical) addAttr(attributes, "Vertical", vertical);
  if (fulfillmentType) addAttr(attributes, "Fulfillment Type", fulfillmentType);

  addAttr(
    attributes,
    "Delivery Mode",
    deliveryMode === "delivery" ? "With delivery" : "Without delivery"
  );
  addAttr(attributes, "Delivery Enabled", deliveryEnabled ? "Yes" : "No");
  addAttr(
    attributes,
    "Physical Item Included",
    physicalItemIncluded ? "Yes" : "No"
  );
  addAttr(attributes, "Official Item", officialItem ? "Yes" : "No");
  addAttr(attributes, "Suggested Market", suggestedMarketType || "STANDARD");
  addAttr(
    attributes,
    "Protected Market Required",
    requiresProtectedMarket ? "Yes" : "No"
  );

  if (isUnique) addAttr(attributes, "Unique", "Yes");

  if (Array.isArray(originalAttributes) && originalAttributes.length > 0) {
    attributes.push(...originalAttributes);
  }

  addAttr(attributes, "Contract", contract1155);
  addAttr(
    attributes,
    "Last Updated",
    new Date(Number(block.timestamp) * 1000).toISOString()
  );

  return {
    contract: contract1155,
    tokenId: tokenId.toString(),
    tokenUri: tokenUri || null,

    name,
    description,
    image: imageHttp,
    animation_url: animHttp,

    category,
    subcategory,
    project,
    brandProject,
    brand,
    collection,
    item,
    itemType,
    rarity,
    vertical,

    proof,
    external_url,

    deliveryMode,
    deliveryEnabled,
    physicalItemIncluded,
    officialItem,

    fulfillmentType,
    suggestedMarketType,
    requiresProtectedMarket,

    attributes,
  };
}

async function handleMetadata1155(req, res, explicitContractRaw = "") {
  try {
    res.set({
      "Cache-Control": "public, max-age=60, s-maxage=60, must-revalidate",
    });

    let tokenId;
    try {
      tokenId = BigInt(req.params.tokenId);
    } catch {
      return res.status(400).json({ status: "error", message: "Invalid tokenId" });
    }

    const queryContract = String(req.query?.contract || "").trim();
    const preferredContract = explicitContractRaw || queryContract || "";

    const contract1155 = await resolve1155ContractForToken(
      tokenId,
      preferredContract
    );

    if (!contract1155) {
      return res.status(500).json({
        status: "error",
        message:
          "No 1155 contract configured. Set REALIFE_1155_NEW_CONTRACT and/or REALIFE_1155_DELIVERY_CONTRACT",
      });
    }

    const payload = await build1155MetadataResponse(contract1155, tokenId);
    return res.json(payload);
  } catch (err) {
    console.error("METADATA1155 ERROR:", err);
    return res.status(500).json({ status: "error" });
  }
}

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
  limits: { fileSize: 100 * 1024 * 1024 },
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "accurate-art",
    message: "Backend is running",
    rpcUrl: RPC_URL,
    contracts: {
      standard1155: REALIFE_1155_STANDARD_CONTRACT || null,
      delivery1155: REALIFE_1155_DELIVERY_CONTRACT || null,
      protectedMarketplace: REALIFE_PROTECTED_MARKETPLACE_CONTRACT || null,
    },
  });
});

/* =========================
   HELPERS: Pinata upload
========================= */
async function pinFileToIpfs(buffer, filename, jwt) {
  const fileForm = new FormData();
  fileForm.append("file", buffer, filename);

  const r = await axios.post(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    fileForm,
    {
      maxBodyLength: Infinity,
      headers: {
        ...fileForm.getHeaders(),
        Authorization: `Bearer ${jwt}`,
      },
    }
  );

  const cid = r.data?.IpfsHash;
  if (!cid) throw new Error("Pinata pinFileToIPFS: missing IpfsHash");
  return `ipfs://${cid}`;
}

/* =========================
   MINT PREPARE (UPLOAD + METADATA)
   - Returns tokenURI (metadataUri)
   - Frontend calls 1155 contract createEdition(supply, tokenURI)
   - Updated for PROTECTED system:
     supports subcategory + fulfillmentType + suggestedMarketType
========================= */
app.post(
  "/api/mint/prepare",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "poster", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        name,
        description,
        category,
        subcategory,
        project,
        brandProject,
        brand,
        itemType,
        fulfillmentType,
        deliveryMode,
        supply,
        proofUrl,
        collection,
        drink,
        item,
        rarity,
        externalUrl,
        vertical,
        deliveryEnabled,
        physicalItemIncluded,
        officialItem,
      } = req.body;

      const fileArr = req.files?.file || [];
      const posterArr = req.files?.poster || [];
      const file = fileArr[0] || null;
      const posterFile = posterArr[0] || null;

      if (!name || !file) {
        return res
          .status(400)
          .json({ status: "error", message: "Name and file are required" });
      }

      if (!process.env.PINATA_JWT) {
        return res
          .status(500)
          .json({ status: "error", message: "PINATA_JWT is missing" });
      }

      const isVideo = String(file.mimetype || "").startsWith("video/");
      const isPosterOk = posterFile
        ? String(posterFile.mimetype || "").startsWith("image/")
        : false;

      if (posterFile && !isPosterOk) {
        return res
          .status(400)
          .json({ status: "error", message: "Poster must be an image file" });
      }

      /* ========= 1️⃣ Upload main file ========= */
      const mediaUri = await pinFileToIpfs(
        file.buffer,
        file.originalname || "media",
        process.env.PINATA_JWT
      );

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
            posterUri = await pinFileToIpfs(
              posterBuf,
              "poster.jpg",
              process.env.PINATA_JWT
            );
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
      const safeName = cleanString(name, 300);
      const safeDescription = cleanString(description, 5000);
      const safeCategory = cleanString(category, 200) || "Other";
      const safeSubcategory = cleanString(subcategory, 200) || null;
      const safeProject = cleanString(project, 200) || "Realife";

      const safeBrandProject =
        cleanString(brandProject, 200) ||
        cleanString(safeProject, 200) ||
        "Realife";

      const safeBrand = cleanString(brand, 200) || null;
      const safeCollection =
        cleanString(collection, 200) ||
        cleanString(safeProject, 200) ||
        "Realife";

      const safeDrink = cleanString(drink, 200) || null;
      const safeItem = cleanString(item, 200) || null;
      const safeItemType =
        cleanString(itemType, 200) || safeItem || null;

      const safeRarity = cleanString(rarity, 120) || null;
      const safeSupply = Number(supply) || 1;
      const safeProofUrl = cleanString(proofUrl, 1000) || null;
      const safeExternalUrl =
        cleanString(externalUrl, 1000) ||
        cleanString(proofUrl, 1000) ||
        null;

      const safeVertical = cleanString(vertical, 120) || null;
      const safeOfficialItem = toBool(officialItem);

      const protectedFields = computeProtectedFields({
        fulfillmentType,
        deliveryMode,
        deliveryEnabled,
        physicalItemIncluded,
      });

      const finalFulfillmentType = protectedFields.finalFulfillmentType;
      const finalDeliveryMode = protectedFields.safeDeliveryMode;
      const finalDeliveryEnabled = protectedFields.finalDeliveryEnabled;
      const finalPhysicalItemIncluded =
        protectedFields.finalPhysicalItemIncluded;
      const suggestedMarketType = protectedFields.suggestedMarketType;
      const requiresProtectedMarket =
        protectedFields.requiresProtectedMarket;

      const shouldIncludeDeliveryAttributes =
        safeVertical === "store" ||
        safeVertical === "cafe" ||
        finalDeliveryMode === "delivery" ||
        finalDeliveryEnabled ||
        finalPhysicalItemIncluded ||
        safeOfficialItem ||
        !!finalFulfillmentType;

      const attributes = [];
      addAttr(attributes, "Collection", safeCollection);
      addAttr(attributes, "Project", safeProject);
      addAttr(attributes, "Brand Project", safeBrandProject);
      addAttr(attributes, "Brand", safeBrand);
      addAttr(attributes, "Category", safeCategory);
      addAttr(attributes, "Subcategory", safeSubcategory);
      addAttr(attributes, "Item", safeItem);
      addAttr(attributes, "Item Type", safeItemType);
      addAttr(attributes, "Drink", safeDrink);
      addAttr(attributes, "Rarity", safeRarity);
      addAttr(attributes, "Vertical", safeVertical);
      addAttr(attributes, "Fulfillment Type", finalFulfillmentType);
      addAttr(
        attributes,
        "Delivery Mode",
        finalDeliveryMode === "delivery"
          ? "With delivery"
          : "Without delivery"
      );

      if (shouldIncludeDeliveryAttributes) {
        addAttr(
          attributes,
          "Delivery Enabled",
          finalDeliveryEnabled ? "Yes" : "No"
        );
        addAttr(
          attributes,
          "Physical Item Included",
          finalPhysicalItemIncluded ? "Yes" : "No"
        );
        addAttr(
          attributes,
          "Official Item",
          safeOfficialItem ? "Yes" : "No"
        );
      }

      addAttr(attributes, "Suggested Market", suggestedMarketType);
      addAttr(
        attributes,
        "Protected Market Required",
        requiresProtectedMarket ? "Yes" : "No"
      );
      addAttr(attributes, "Supply", String(safeSupply));

      const metadata = {
        name: safeName,
        description: safeDescription,

        category: safeCategory,
        subcategory: safeSubcategory,
        project: safeProject,
        brandProject: safeBrandProject,
        brand: safeBrand,
        collection: safeCollection,
        item: safeItem,
        itemType: safeItemType,
        drink: safeDrink,
        rarity: safeRarity,
        supply: safeSupply,

        vertical: safeVertical,
        fulfillmentType: finalFulfillmentType,
        suggestedMarketType,
        requiresProtectedMarket,

        deliveryMode: finalDeliveryMode,
        deliveryEnabled: finalDeliveryEnabled,
        physicalItemIncluded: finalPhysicalItemIncluded,
        officialItem: safeOfficialItem,

        proof: safeProofUrl,
        external_url: safeExternalUrl,
        attributes,
      };

      if (isVideo) {
        metadata.animation_url = mediaUri;
        metadata.image = posterUri;
      } else {
        metadata.image = mediaUri;
      }

      /* ========= 4️⃣ Upload METADATA ========= */
      const metadataUpload = await axios.post(
        "https://api.pinata.cloud/pinning/pinJSONToIPFS",
        metadata,
        {
          headers: {
            Authorization: `Bearer ${process.env.PINATA_JWT}`,
            "Content-Type": "application/json",
          },
        }
      );

      const metadataCid = metadataUpload.data?.IpfsHash;
      if (!metadataCid) {
        throw new Error("Pinata pinJSONToIPFS: missing IpfsHash");
      }

      const metadataUri = `ipfs://${metadataCid}`;

      /* ========= 5️⃣ RESPONSE ========= */
      return res.json({
        status: "ready",
        metadataUri,
        tokenURI: metadataUri,
        preview: {
          name: metadata.name,
          category: metadata.category,
          subcategory: metadata.subcategory,
          project: metadata.project,
          brandProject: metadata.brandProject,
          brand: metadata.brand,
          collection: metadata.collection,
          item: metadata.item,
          itemType: metadata.itemType,
          drink: metadata.drink,
          rarity: metadata.rarity,
          vertical: metadata.vertical,

          fulfillmentType: metadata.fulfillmentType,
          suggestedMarketType: metadata.suggestedMarketType,
          requiresProtectedMarket: metadata.requiresProtectedMarket,

          deliveryMode: metadata.deliveryMode,
          deliveryEnabled: metadata.deliveryEnabled,
          physicalItemIncluded: metadata.physicalItemIncluded,
          officialItem: metadata.officialItem,

          kind: isVideo ? "video" : "image",
          media: isVideo ? metadata.animation_url : metadata.image,
          poster: isVideo ? metadata.image : null,
          image: metadata.image,
          supply: metadata.supply,
        },
      });
    } catch (err) {
      console.error("MINT PREPARE ERROR:", err?.message || err);
      return res
        .status(500)
        .json({ status: "error", message: "Mint preparation failed" });
    }
  }
);

/* =========================
   DYNAMIC NFT METADATA (ERC-1155)
   NEW:
   - GET /metadata1155/:contract/:tokenId
   LEGACY:
   - GET /metadata1155/:tokenId
   - GET /metadata1155/:tokenId?contract=0x...
========================= */
app.get("/metadata1155/:contract/:tokenId", async (req, res) => {
  const explicitContract = String(req.params.contract || "").trim();
  return handleMetadata1155(req, res, explicitContract);
});

app.get("/metadata1155/:tokenId", async (req, res) => {
  return handleMetadata1155(req, res, "");
});

/* =========================
   START SERVER (ALWAYS LAST)
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`accurate-art running on port ${PORT}`);
  console.log("[1155 contracts]", {
    standard: REALIFE_1155_STANDARD_CONTRACT || null,
    delivery: REALIFE_1155_DELIVERY_CONTRACT || null,
    protectedMarketplace: REALIFE_PROTECTED_MARKETPLACE_CONTRACT || null,
  });
});