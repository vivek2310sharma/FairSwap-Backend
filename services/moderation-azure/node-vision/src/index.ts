import { createHash } from "node:crypto";
import path from "node:path";
import express from "express";
import { z } from "zod";
import * as tf from "@tensorflow/tfjs-node";
import * as nsfwjs from "nsfwjs";
import * as mobilenet from "@tensorflow-models/mobilenet";

const app = express();
app.use(express.json({ limit: "5mb" }));

const INTERNAL_SECRET = process.env.MODERATION_SECRET;
if (!INTERNAL_SECRET || INTERNAL_SECRET.length < 16) {
  console.error("FATAL: MODERATION_SECRET missing or insecure");
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8081;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_STORAGE_HOST = process.env.ALLOWED_STORAGE_HOST;
if (!ALLOWED_STORAGE_HOST) {
  console.error("FATAL: ALLOWED_STORAGE_HOST is required");
  process.exit(1);
}

const VisionScanRequestSchema = z.object({
  media: z.array(
    z.object({
      id: z.string().uuid(),
      originalStoragePath: z.string().min(1),
      scopedSignedUrl: z.string().url(),
      mediaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
  ),
  expectedCategory: z.string().optional(),
});

let nsfwModel: nsfwjs.NSFWJS | null = null;
let mobileNetModel: mobilenet.MobileNet | null = null;

async function loadModels() {
  console.log("Loading NSFWJS and MobileNet models from local filesystem...");
  try {
    const modelsDir = path.resolve(process.cwd(), "models");
    const nsfwJsonPath = `file://${path.join(modelsDir, "nsfwjs", "model.json")}`;
    const mobilenetJsonPath = `file://${path.join(modelsDir, "mobilenet_v2", "model.json")}`;

    nsfwModel = await nsfwjs.load(nsfwJsonPath, { size: 224 });
    mobileNetModel = await mobilenet.load({
      version: 2,
      alpha: 1.0,
      modelUrl: mobilenetJsonPath,
    });
    console.log("Vision models successfully initialized from local filesystem.");
  } catch (err) {
    console.error("Failed to load vision models:", err);
  }
}

app.get("/healthz", (_, res) => {
  const ready = Boolean(nsfwModel && mobileNetModel);
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "initializing" });
});

app.post("/scan", async (req, res) => {
  const secret = req.headers["x-internal-secret"];
  if (secret !== INTERNAL_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!nsfwModel || !mobileNetModel) {
    res.status(503).json({ error: "Vision models not ready" });
    return;
  }

  const parsed = VisionScanRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    return;
  }

  const { media, expectedCategory } = parsed.data;
  const results: any[] = [];
  const flags: any[] = [];
  let allSuccess = true;

  for (const item of media) {
    try {
      const parsedUrl = new URL(item.scopedSignedUrl);
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.hostname.toLowerCase() !== ALLOWED_STORAGE_HOST.toLowerCase() ||
        !parsedUrl.pathname.includes("/storage/v1/object/sign/listing-originals/")
      ) {
        results.push({
          mediaId: item.id,
          sha256Verified: false,
          status: "download_failed",
          error: "STORAGE_ORIGIN_VIOLATION",
        });
        allSuccess = false;
        continue;
      }

      const imgRes = await fetch(item.scopedSignedUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });

      if (!imgRes.ok) {
        results.push({
          mediaId: item.id,
          sha256Verified: false,
          status: "download_failed",
          error: `HTTP_${imgRes.status}`,
        });
        allSuccess = false;
        continue;
      }

      const contentLength = Number(imgRes.headers.get("content-length") || 0);
      if (contentLength > MAX_IMAGE_BYTES) {
        results.push({
          mediaId: item.id,
          sha256Verified: false,
          status: "download_failed",
          error: "IMAGE_SIZE_EXCEEDS_LIMIT",
        });
        allSuccess = false;
        continue;
      }

      const arrayBuffer = await imgRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const computedHash = createHash("sha256").update(buffer).digest("hex");
      if (computedHash !== item.mediaSha256) {
        results.push({
          mediaId: item.id,
          sha256Verified: false,
          status: "hash_mismatch",
          error: "COMPUTED_HASH_MISMATCH",
        });
        allSuccess = false;
        continue;
      }

      let imageTensor: tf.Tensor3D;
      try {
        imageTensor = tf.node.decodeImage(buffer, 3) as tf.Tensor3D;
      } catch {
        results.push({
          mediaId: item.id,
          sha256Verified: true,
          status: "decode_failed",
          error: "IMAGE_DECODE_ERROR",
        });
        allSuccess = false;
        continue;
      }

      const nsfwPredictions = await nsfwModel.classify(imageTensor);
      const pornProb = nsfwPredictions.find((p) => p.className === "Porn")?.probability || 0;
      const sexyProb = nsfwPredictions.find((p) => p.className === "Sexy")?.probability || 0;
      const hentaiProb = nsfwPredictions.find((p) => p.className === "Hentai")?.probability || 0;

      if (pornProb > 0.6 || hentaiProb > 0.6) {
        flags.push({
          check: "vision_nsfw",
          field: "media",
          code: "EXPLICIT_NUDITY_DETECTED",
          reason: "Explicit nudity or adult content detected in listing image.",
          severity: "critical",
          boundedEvidence: `score:${Math.round(Math.max(pornProb, hentaiProb) * 100)}%`,
        });
      } else if (sexyProb > 0.85) {
        flags.push({
          check: "vision_nsfw",
          field: "media",
          code: "SUGGESTIVE_CONTENT_FLAG",
          reason: "High suggestive content score in listing image.",
          severity: "warning",
          boundedEvidence: `score:${Math.round(sexyProb * 100)}%`,
        });
      }

      const classifications = await mobileNetModel.classify(imageTensor, 3);
      imageTensor.dispose();

      if (expectedCategory && (expectedCategory.includes("car") || expectedCategory.includes("wheeler"))) {
        const topClass = classifications[0]?.className.toLowerCase() || "";
        const isVehicle = /\b(car|motorcycle|scooter|vehicle|wheel|truck|van|cab)\b/i.test(topClass);
        const isCompletelyUnrelated = /\b(dog|cat|bird|flower|tree|pizza|burger)\b/i.test(topClass);

        if (!isVehicle && isCompletelyUnrelated) {
          flags.push({
            check: "vision_category",
            field: "media",
            code: "CATEGORY_MISMATCH_SUGGESTION",
            reason: "Detected image subject may not match the selected category.",
            severity: "warning",
            boundedEvidence: `detected:${topClass.split(",")[0]}`,
          });
        }
      }

      results.push({
        mediaId: item.id,
        sha256Verified: true,
        status: "success",
      });
    } catch (err: any) {
      results.push({
        mediaId: item.id,
        sha256Verified: false,
        status: "timeout",
        error: err?.message?.slice(0, 100) || "UNKNOWN_ERROR",
      });
      allSuccess = false;
    }
  }

  res.status(200).json({
    status: allSuccess ? "completed" : "incomplete",
    scannedCount: results.filter((r) => r.status === "success").length,
    results,
    flags,
  });
});

loadModels().then(() => {
  app.listen(PORT, () => {
    console.log(`FairSwap Node Vision Worker running on port ${PORT}`);
  });
});
