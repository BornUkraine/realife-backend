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
  let deliveryMode = "none";
  let deliveryEnabled = false;
  let physicalItemIncluded = false;
  let officialItem = false;
  let vertical = null;
  let proof = null;
  let external_url = null;
  let fulfillmentType = null;
  let suggestedMarketType = null;

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
      subcategory = originalMetadata.data?.subcategory ?? null;
      project = originalMetadata.data?.project ?? null;
      collection = originalMetadata.data?.collection ?? null;
      item = originalMetadata.data?.item ?? null;
      itemType = originalMetadata.data?.itemType ?? null;
      rarity = originalMetadata.data?.rarity ?? null;
      brandProject = originalMetadata.data?.brandProject ?? null;
      brand = originalMetadata.data?.brand ?? null;
      vertical = originalMetadata.data?.vertical ?? null;
      proof = originalMetadata.data?.proof ?? null;
      external_url = originalMetadata.data?.external_url ?? null;

      deliveryMode =
        String(originalMetadata.data?.deliveryMode || "")
          .trim()
          .toLowerCase() === "delivery"
          ? "delivery"
          : "none";

      deliveryEnabled = toBool(originalMetadata.data?.deliveryEnabled);
      physicalItemIncluded = toBool(originalMetadata.data?.physicalItemIncluded);
      officialItem = toBool(originalMetadata.data?.officialItem);

      fulfillmentType = normalizeFulfillmentType(
        originalMetadata.data?.fulfillmentType
      );

      suggestedMarketType = safeTrim(originalMetadata.data?.suggestedMarketType);

      originalAttributes = Array.isArray(originalMetadata.data?.attributes)
        ? originalMetadata.data.attributes
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

  if (!fulfillmentType) {
    if (deliveryEnabled || physicalItemIncluded || deliveryMode === "delivery") {
      fulfillmentType = "PHYSICAL_GOOD";
    }
  }

  if (!suggestedMarketType) {
    suggestedMarketType = inferSuggestedMarketType({
      fulfillmentType,
      deliveryEnabled,
      physicalItemIncluded,
    });
  }

  const block = await client.getBlock();

  const imageHttp = image ? ipfsToHttp(image) : null;
  const animHttp = animation_url ? ipfsToHttp(animation_url) : null;

  const isUnique = max === 1n;

  const attributes = [
    { trait_type: "Standard", value: "ERC1155" },
    { trait_type: "Token ID", value: tokenId.toString() },
    { trait_type: "Total Supply", value: totalSupply.toString() },
    ...(max > 0n ? [{ trait_type: "Max Supply", value: max.toString() }] : []),
    ...(creator ? [{ trait_type: "Creator", value: creator }] : []),
    ...(category ? [{ trait_type: "Category", value: category }] : []),
    ...(subcategory ? [{ trait_type: "Subcategory", value: subcategory }] : []),
    ...(project ? [{ trait_type: "Project", value: project }] : []),
    ...(brandProject ? [{ trait_type: "Brand Project", value: brandProject }] : []),
    ...(brand ? [{ trait_type: "Brand", value: brand }] : []),
    ...(collection ? [{ trait_type: "Collection", value: collection }] : []),
    ...(item ? [{ trait_type: "Item", value: item }] : []),
    ...(itemType ? [{ trait_type: "Item Type", value: itemType }] : []),
    ...(rarity ? [{ trait_type: "Rarity", value: rarity }] : []),
    ...(vertical ? [{ trait_type: "Vertical", value: vertical }] : []),
    ...(humanFulfillmentType(fulfillmentType)
      ? [
          {
            trait_type: "Fulfillment Type",
            value: humanFulfillmentType(fulfillmentType),
          },
        ]
      : []),
    {
      trait_type: "Delivery Mode",
      value: deliveryMode === "delivery" ? "With delivery" : "Without delivery",
    },
    { trait_type: "Delivery Enabled", value: deliveryEnabled ? "Yes" : "No" },
    {
      trait_type: "Physical Item Included",
      value: physicalItemIncluded ? "Yes" : "No",
    },
    { trait_type: "Official Item", value: officialItem ? "Yes" : "No" },
    {
      trait_type: "Suggested Market",
      value: suggestedMarketType === "protected" ? "Protected" : "Standard",
    },
    ...(isUnique ? [{ trait_type: "Unique", value: "Yes" }] : []),
    ...originalAttributes,
    { trait_type: "Contract", value: contract1155 },
    {
      trait_type: "Last Updated",
      value: new Date(Number(block.timestamp) * 1000).toISOString(),
    },
  ];

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
    },
    aiSuggest: {
      enabled: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_AI_SUGGEST_MODEL || "gpt-5.4-mini",
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
   AI SUGGEST
========================= */
app.post(
  "/api/ai-suggest",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "poster", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({
          status: "error",
          message: "OPENAI_API_KEY is missing",
        });
      }

      const model = process.env.OPENAI_AI_SUGGEST_MODEL || "gpt-5.4-mini";

      const {
        name,
        description,
        project,
        brand,
        deliveryMode,
      } = req.body || {};

      const fileArr = req.files?.file || [];
      const posterArr = req.files?.poster || [];
      const file = fileArr[0] || null;
      const posterFile = posterArr[0] || null;

      if (!file) {
        return res.status(400).json({
          status: "error",
          message: "File is required",
        });
      }

      const isVideo = String(file.mimetype || "").startsWith("video/");
      let aiImageBuffer = null;
      let aiImageMime = "image/jpeg";

      if (isVideo) {
        if (
          posterFile &&
          String(posterFile.mimetype || "").startsWith("image/")
        ) {
          aiImageBuffer = posterFile.buffer;
          aiImageMime = posterFile.mimetype || guessMimeFromFilename(posterFile.originalname);
        } else {
          try {
            aiImageBuffer = await makePosterFromVideo(file.buffer);
            aiImageMime = "image/jpeg";
          } catch {
            aiImageBuffer = null;
          }
        }
      } else if (String(file.mimetype || "").startsWith("image/")) {
        aiImageBuffer = file.buffer;
        aiImageMime = file.mimetype || guessMimeFromFilename(file.originalname);
      }

      if (!aiImageBuffer) {
        return res.status(400).json({
          status: "error",
          message:
            "AI suggest needs an image. For video, upload poster or allow server poster extraction.",
        });
      }

      const imageDataUrl = bufferToDataUrl(aiImageBuffer, aiImageMime);
      const currentDeliveryMode =
        String(deliveryMode || "").trim().toLowerCase() === "delivery"
          ? "delivery"
          : "none";

      const systemPrompt = `
You classify uploaded NFT media for a Web3 marketplace called Realife.

Return only valid JSON matching the schema.

Goal:
- Understand what the uploaded image most likely represents.
- Suggest the best marketplace structure.

Rules:
1. path must be one of:
   - "collectible"
   - "service"
   - "physical_product"

2. category must be one of:
${AI_ALLOWED_CATEGORIES.map((x) => `- ${x}`).join("\n")}

3. itemType should be short and useful.
   Examples:
   "T-shirt", "Coffee", "Chocolate", "Website", "Consultation", "Coaching", "Artwork", "Collectible", "Repair Service", "Interior Design"

4. itemLabel should be the concrete offer.
   Examples:
   "Graphic T-shirt", "1:1 Fitness Coaching", "Landing Page Design", "Coffee Bag", "Vintage Lamp"

5. subcategory should be a niche or style.
   Examples:
   "Streetwear", "Yoga Coaching", "Brand Identity", "Home Repair", "Handmade Product"

6. title should be short and marketplace-friendly.

7. fulfillmentType:
   - "PHYSICAL_GOOD" for real physical products / merch / packaged goods / objects
   - "DIGITAL_SERVICE" for websites, branding, design, automation, digital work
   - "ONLINE_SESSION" for coaching, consultation, lesson, training, remote calls
   - "LOCAL_SERVICE" for repair, local visits, in-person service, offline work
   - null if it looks like a normal collectible/art NFT

8. suggestedMarketType:
   - "protected" if fulfillmentType is not null
   - "standard" if collectible

9. If the current deliveryMode from the user is "delivery", force:
   - path = "physical_product"
   - fulfillmentType = "PHYSICAL_GOOD"
   - suggestedMarketType = "protected"

10. Prefer practical marketplace classification over artistic interpretation.
`;

      const userText = [
        `Current delivery mode: ${currentDeliveryMode}`,
        `Project: ${String(project || "").trim() || "Realife"}`,
        `Current name: ${String(name || "").trim() || ""}`,
        `Current brand: ${String(brand || "").trim() || ""}`,
        `Current description: ${String(description || "").trim() || ""}`,
        `Task: analyze the uploaded media and classify it for marketplace minting.`,
      ]
        .filter(Boolean)
        .join("\n");

      const schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            enum: ["collectible", "service", "physical_product"],
          },
          category: {
            type: "string",
            enum: AI_ALLOWED_CATEGORIES,
          },
          itemType: { type: ["string", "null"] },
          itemLabel: { type: ["string", "null"] },
          subcategory: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          brand: { type: ["string", "null"] },
          fulfillmentType: {
            type: ["string", "null"],
            enum: [
              "PHYSICAL_GOOD",
              "DIGITAL_SERVICE",
              "ONLINE_SESSION",
              "LOCAL_SERVICE",
              null,
            ],
          },
          suggestedMarketType: {
            type: "string",
            enum: ["standard", "protected"],
          },
          reasoning: { type: ["string", "null"] },
          searchTags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "path",
          "category",
          "itemType",
          "itemLabel",
          "subcategory",
          "title",
          "brand",
          "fulfillmentType",
          "suggestedMarketType",
          "reasoning",
          "searchTags",
        ],
      };

      const openaiRes = await axios.post(
        "https://api.openai.com/v1/responses",
        {
          model,
          store: false,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: systemPrompt.trim() }],
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: userText },
                {
                  type: "input_image",
                  image_url: imageDataUrl,
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "realife_ai_suggest",
              strict: true,
              schema,
            },
          },
        },
        {
          timeout: 90_000,
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const rawText = pickResponseText(openaiRes.data);
      const parsed = safeJsonParse(rawText, null);

      if (!parsed || typeof parsed !== "object") {
        console.error("AI_SUGGEST_PARSE_ERROR", rawText);
        return res.status(500).json({
          status: "error",
          message: "AI suggest parse failed",
        });
      }

      const suggestion = normalizeAiSuggestion(parsed, currentDeliveryMode);

      return res.json({
        status: "ok",
        model,
        suggestion,
      });
    } catch (err) {
      console.error(
        "AI_SUGGEST_ERROR:",
        err?.response?.data || err?.message || err
      );

      return res.status(500).json({
        status: "error",
        message: "AI suggest failed",
      });
    }
  }
);

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
      const safeName = String(name || "").trim();
      const safeDescription = String(description || "").trim();
      const safeCategory = String(category || "Other").trim();
      const safeSubcategory = safeTrim(subcategory);
      const safeProject = String(project || "Realife").trim();

      const safeBrandProject = String(
        brandProject || safeProject || "Realife"
      ).trim();
      const safeBrand = String(brand || "").trim() || null;

      const safeCollection = String(collection || safeProject || "Realife").trim();
      const safeDrink = String(drink || "").trim();
      const safeItem = String(item || "").trim();
      const safeItemType = String(itemType || "").trim() || safeItem || null;

      const safeRarity = String(rarity || "").trim();
      const safeSupply = Number(supply) || 1;
      const safeProofUrl = String(proofUrl || "").trim() || null;
      const safeExternalUrl = String(externalUrl || proofUrl || "").trim() || null;
      const safeVertical = String(vertical || "").trim() || null;

      const safeDeliveryMode =
        String(deliveryMode || "").trim().toLowerCase() === "delivery"
          ? "delivery"
          : "none";

      const safeDeliveryEnabled =
        toBool(deliveryEnabled) || safeDeliveryMode === "delivery";

      const safePhysicalItemIncluded =
        toBool(physicalItemIncluded) || safeDeliveryMode === "delivery";

      const safeOfficialItem = toBool(officialItem);

      const shouldIncludeDeliveryAttributes =
        safeVertical === "store" ||
        safeVertical === "cafe" ||
        safeDeliveryMode === "delivery" ||
        safeDeliveryEnabled ||
        safePhysicalItemIncluded ||
        safeOfficialItem;

      const attributes = [
        { trait_type: "Collection", value: safeCollection },
        { trait_type: "Project", value: safeProject },
        ...(safeBrandProject
          ? [{ trait_type: "Brand Project", value: safeBrandProject }]
          : []),
        ...(safeBrand ? [{ trait_type: "Brand", value: safeBrand }] : []),
        { trait_type: "Category", value: safeCategory },
        ...(safeSubcategory
          ? [{ trait_type: "Subcategory", value: safeSubcategory }]
          : []),
        ...(safeItem ? [{ trait_type: "Item", value: safeItem }] : []),
        ...(safeItemType ? [{ trait_type: "Item Type", value: safeItemType }] : []),
        ...(safeDrink ? [{ trait_type: "Drink", value: safeDrink }] : []),
        ...(safeRarity ? [{ trait_type: "Rarity", value: safeRarity }] : []),
        ...(safeVertical ? [{ trait_type: "Vertical", value: safeVertical }] : []),
        ...(humanFulfillmentType(finalFulfillmentType)
          ? [
              {
                trait_type: "Fulfillment Type",
                value: humanFulfillmentType(finalFulfillmentType),
              },
            ]
          : []),
        {
          trait_type: "Delivery Mode",
          value:
            safeDeliveryMode === "delivery"
              ? "With delivery"
              : "Without delivery",
        },
        ...(shouldIncludeDeliveryAttributes
          ? [
              {
                trait_type: "Delivery Enabled",
                value: safeDeliveryEnabled ? "Yes" : "No",
              },
              {
                trait_type: "Physical Item Included",
                value: safePhysicalItemIncluded ? "Yes" : "No",
              },
              {
                trait_type: "Official Item",
                value: safeOfficialItem ? "Yes" : "No",
              },
            ]
          : []),
        {
          trait_type: "Suggested Market",
          value: suggestedMarketType === "protected" ? "Protected" : "Standard",
        },
        { trait_type: "Supply", value: String(safeSupply) },
      ];

      const metadata = {
        name: safeName,
        description: safeDescription,

        category: safeCategory,
        subcategory: safeSubcategory,
        project: safeProject,
        brandProject: safeBrandProject,
        brand: safeBrand,
        collection: safeCollection,
        item: safeItem || null,
        itemType: safeItemType || null,
        drink: safeDrink || null,
        rarity: safeRarity || null,
        supply: safeSupply,

        vertical: safeVertical,
        deliveryMode: safeDeliveryMode,
        deliveryEnabled: safeDeliveryEnabled,
        physicalItemIncluded: safePhysicalItemIncluded,
        officialItem: safeOfficialItem,

        fulfillmentType: finalFulfillmentType,
        suggestedMarketType,

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
          deliveryMode: metadata.deliveryMode,
          deliveryEnabled: metadata.deliveryEnabled,
          physicalItemIncluded: metadata.physicalItemIncluded,
          officialItem: metadata.officialItem,
          fulfillmentType: metadata.fulfillmentType,
          suggestedMarketType: metadata.suggestedMarketType,
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
  });
  console.log("[ai-suggest]", {
    enabled: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_AI_SUGGEST_MODEL || "gpt-5.4-mini",
  });
});