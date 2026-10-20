import { z } from "zod";
import {
  CATEGORIES,
  IMAGE_CATEGORIES,
  MODEL,
  SnapshotV2Schema,
} from "../../../src/lib/moderation/v2/contract";
import { canonicalResolver } from "./listing-moderation-v2-media.ts";
import type { WorkerDependencies } from "./listing-moderation-v2-worker.ts";
const Package = z.object({
  synthetic_only: z.literal(true),
  processor_build: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(
    z.object({
      snapshot: SnapshotV2Schema,
      media_id: z.string().uuid(),
      canonical_base64: z.string().max(128000),
    }).strict(),
  ).min(1).max(8),
}).strict();
/** A trusted, hash-pinned release fixture package, NEVER an HTTP-body upload.
 * Local/Test synthetic-only implementation; no general Storage credential or
 * arbitrary URL fetching. Package provenance is the trusted fixture authority,
 * separate from the byte hashes checked on every canonical read.
 */
export async function syntheticDependencies(
  json: string,
  pin: string,
  processorBuild: string,
): Promise<Pick<WorkerDependencies, "media" | "transport" | "apiKey">> {
  if (json.length > 1024 * 1024 || !/^[0-9a-f]{64}$/.test(pin)) {
    throw Error("FIXTURE_PACKAGE_REJECTED");
  }
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== pin) throw Error("FIXTURE_PACKAGE_REJECTED");
  const pkg = Package.parse(JSON.parse(json));
  if (pkg.processor_build !== processorBuild) {
    throw Error("FIXTURE_PROCESSOR_REJECTED");
  }
  const media = canonicalResolver({
    processorBuild,
    seal: async (c, l) => {
      const e = pkg.entries.find((e) =>
        e.snapshot.snapshot_sha256 === c.snapshot.snapshot_sha256 &&
        e.media_id === l.media_id
      );
      const m = e?.snapshot.media.find((m) => m.media_id === l.media_id);
      if (!e || !m) throw Error("FIXTURE_SEAL_NOT_AUTHORIZED");
      return {
        authority: "reviewed_synthetic_seal",
        processor_build: pkg.processor_build,
        snapshot_sha256: e.snapshot.snapshot_sha256,
        sealed_media: m,
      };
    },
    read: async (l, signal) => {
      if (signal.aborted) throw Error("CANCELLED");
      const e = pkg.entries.find((e) =>
        e.media_id === l.media_id &&
        e.snapshot.media.some((m) =>
          m.media_id === l.media_id && m.asset_version === l.asset_version &&
          m.canonical.object_id === l.object_id
        )
      );
      if (!e) throw Error("FIXTURE_OBJECT_NOT_AUTHORIZED");
      const bytes = Uint8Array.from(
        atob(e.canonical_base64),
        (c) => c.charCodeAt(0),
      );
      return new Response(bytes, {
        headers: {
          "content-type": "image/webp",
          "content-length": String(bytes.length),
        },
      });
    },
  });
  // Always mocked, regardless of environment keys. No global fetch fallback.
  const transport: WorkerDependencies["transport"] = async (url, init) => {
    if (
      url !== "https://api.openai.com/v1/moderations" || init.signal?.aborted
    ) throw Error("MOCK_TRANSPORT_REJECTED");
    const body = JSON.parse(String(init.body));
    if (body.model !== MODEL || body.input.length !== 1) {
      throw Error("MOCK_INPUT_REJECTED");
    }
    const kind = body.input[0].type === "text" ? "text" : "image";
    return new Response(JSON.stringify({
      id: "synthetic_test_response",
      model: MODEL,
      results: [{
        flagged: false,
        categories: Object.fromEntries(CATEGORIES.map((c) => [c, false])),
        category_scores: Object.fromEntries(CATEGORIES.map((c) => [c, 0])),
        category_applied_input_types: Object.fromEntries(
          CATEGORIES.map(
            (c) => [
              c,
              kind === "text" || IMAGE_CATEGORIES.includes(c) ? [kind] : [],
            ],
          ),
        ),
      }],
    }));
  };
  return { media, transport, apiKey: "synthetic-test-only" };
}
