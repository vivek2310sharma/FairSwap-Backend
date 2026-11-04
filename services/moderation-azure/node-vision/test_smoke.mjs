import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import * as tf from "@tensorflow/tfjs-node";
import * as nsfwjs from "nsfwjs";
import * as mobilenet from "@tensorflow-models/mobilenet";

const EXPECTED_NSFW_CLASSES = new Set(["Drawing", "Hentai", "Neutral", "Porn", "Sexy"]);

async function runSmokeTest() {
  console.log("Smoke Test: Loading local models from models/ directory...");
  const modelsDir = path.resolve(process.cwd(), "models");
  const nsfwJsonPath = `file://${path.join(modelsDir, "nsfwjs", "model.json")}`;
  const mobilenetJsonPath = `file://${path.join(modelsDir, "mobilenet_v2", "model.json")}`;

  assert(fs.existsSync(path.join(modelsDir, "nsfwjs", "model.json")), "Missing nsfwjs model.json");
  assert(fs.existsSync(path.join(modelsDir, "nsfwjs", "group1-shard1of1")), "Missing nsfwjs shard");
  assert(fs.existsSync(path.join(modelsDir, "mobilenet_v2", "model.json")), "Missing mobilenet model.json");
  assert(fs.existsSync(path.join(modelsDir, "mobilenet_v2", "group1-shard1of4")), "Missing mobilenet shard 1");
  assert(fs.existsSync(path.join(modelsDir, "mobilenet_v2", "group1-shard2of4")), "Missing mobilenet shard 2");
  assert(fs.existsSync(path.join(modelsDir, "mobilenet_v2", "group1-shard3of4")), "Missing mobilenet shard 3");
  assert(fs.existsSync(path.join(modelsDir, "mobilenet_v2", "group1-shard4of4")), "Missing mobilenet shard 4");

  const nsfw = await nsfwjs.load(nsfwJsonPath, { size: 224 });
  console.log("NSFWJS model loaded successfully.");

  const mobile = await mobilenet.load({
    version: 2,
    alpha: 1.0,
    modelUrl: mobilenetJsonPath,
  });
  console.log("MobileNetV2 model loaded successfully.");

  console.log("Smoke Test: Running inference on test fixture...");
  const fixturePath = path.resolve(process.cwd(), "test_fixture.jpg");
  assert(fs.existsSync(fixturePath), `Fixture missing at ${fixturePath}`);
  const imageBuffer = fs.readFileSync(fixturePath);
  const tensor = tf.node.decodeImage(imageBuffer, 3);

  // Assert input shape: 3 channels (RGB)
  assert.strictEqual(tensor.shape.length, 3, "Input tensor must be 3-dimensional [height, width, channels]");
  assert.strictEqual(tensor.shape[2], 3, "Input image must have 3 RGB channels");

  // 1. NSFWJS Predictions Verification
  const nsfwPredictions = await nsfw.classify(tensor);
  console.log("NSFW predictions:", nsfwPredictions.map(p => `${p.className}: ${p.probability.toFixed(3)}`).join(", "));

  assert(Array.isArray(nsfwPredictions), "NSFW predictions must be an array");
  assert.strictEqual(nsfwPredictions.length, 5, `NSFW predictions must contain exactly 5 classes, got ${nsfwPredictions.length}`);

  let nsfwProbSum = 0;
  for (const pred of nsfwPredictions) {
    assert(EXPECTED_NSFW_CLASSES.has(pred.className), `Unexpected NSFW class name: ${pred.className}`);
    assert(typeof pred.probability === "number" && Number.isFinite(pred.probability), `Invalid probability for ${pred.className}: ${pred.probability}`);
    assert(pred.probability >= 0 && pred.probability <= 1.0001, `Probability out of range [0, 1] for ${pred.className}: ${pred.probability}`);
    nsfwProbSum += pred.probability;
  }
  assert(Math.abs(nsfwProbSum - 1.0) < 0.05, `NSFW probabilities must sum close to 1.0, got ${nsfwProbSum}`);

  // 2. MobileNet Predictions Verification
  const mobilePredictions = await mobile.classify(tensor, 5);
  console.log("MobileNet predictions:", mobilePredictions.map(p => `${p.className}: ${p.probability.toFixed(3)}`).join(", "));

  assert(Array.isArray(mobilePredictions), "MobileNet predictions must be an array");
  assert(mobilePredictions.length > 0 && mobilePredictions.length <= 5, "MobileNet must return top predictions");

  let mobileProbSum = 0;
  for (const pred of mobilePredictions) {
    assert(typeof pred.className === "string" && pred.className.length > 0, "MobileNet className must be a non-empty string");
    assert(typeof pred.probability === "number" && Number.isFinite(pred.probability), `Invalid probability for ${pred.className}: ${pred.probability}`);
    assert(pred.probability >= 0 && pred.probability <= 1.0001, `Probability out of range [0, 1] for ${pred.className}: ${pred.probability}`);
    mobileProbSum += pred.probability;
  }
  assert(mobileProbSum <= 1.001, `MobileNet top probability sum cannot exceed 1.0, got ${mobileProbSum}`);

  tensor.dispose();
  console.log("Smoke Test: All assertions (shapes, finite probabilities, classes) passed successfully!");
}

runSmokeTest().catch((err) => {
  console.error("Smoke Test FAILED:", err);
  process.exit(1);
});
