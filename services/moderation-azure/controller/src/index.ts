import express from "express";
import { ControllerConfigSchema, ModerationJobRequestSchema } from "./types";
import { orchestrateModerationJob } from "./orchestrator";

const configResult = ControllerConfigSchema.safeParse({
  port: process.env.PORT,
  moderationSecret: process.env.MODERATION_SECRET,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiApiBase: process.env.OPENAI_API_BASE,
  nodeVisionServiceUrl: process.env.NODE_VISION_SERVICE_URL,
  pythonOcrServiceUrl: process.env.PYTHON_OCR_SERVICE_URL,
  timeoutMs: process.env.TIMEOUT_MS,
  environment: process.env.ENVIRONMENT,
  allowedStorageHost: process.env.ALLOWED_STORAGE_HOST,
});

if (!configResult.success) {
  console.error("FATAL: Invalid configuration:", configResult.error.format());
  process.exit(1);
}

const config = configResult.data;
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_, res) => {
  res.status(200).json({ status: "healthy", service: "azure-moderation-controller" });
});

app.post("/v1/moderate", async (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["x-moderation-secret"];
  const secret = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!secret || secret !== config.moderationSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const jobResult = ModerationJobRequestSchema.safeParse(req.body);
  if (!jobResult.success) {
    res.status(400).json({
      error: "Invalid job payload",
      issues: jobResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }

  try {
    const decision = await orchestrateModerationJob(jobResult.data, config);
    res.status(200).json(decision);
  } catch (err) {
    console.error("Internal orchestration error:", err);
    res.status(500).json({
      verdict: "INCOMPLETE",
      error: "Internal moderation engine error",
    });
  }
});

app.listen(config.port, () => {
  console.log(`FairSwap Azure Moderation Controller listening on port ${config.port}`);
});
