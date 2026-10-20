import type { SnapshotV2 } from "../../../src/lib/moderation/v2/contract";
import type {
  WorkerClaim,
  WorkerDependencies,
} from "./listing-moderation-v2-worker.ts";
import type { Locator } from "./listing-moderation-v2-context.ts";
export type TrustedSeal = {
  snapshot_sha256: string;
  sealed_media: SnapshotV2["media"][number];
  authority: "reviewed_synthetic_seal";
  processor_build: string;
};
export function canonicalResolver(options: {
  read(locator: Readonly<Locator>, signal: AbortSignal): Promise<Response>;
  seal(claim: WorkerClaim, locator: Readonly<Locator>): Promise<TrustedSeal>;
  processorBuild: string;
}): WorkerDependencies["media"] {
  return async (claim, media, signal, locator) => {
    if (
      !locator || signal.aborted ||
      locator.object_id !== media.canonical.object_id ||
      locator.recipe !== "seal_v1" || locator.bucket !== "listing-originals"
    ) throw Error("CANONICAL_AUTHORIZATION_REQUIRED");
    const evidence = await options.seal(claim, Object.freeze({ ...locator }));
    if (
      evidence.authority !== "reviewed_synthetic_seal" ||
      evidence.processor_build !== options.processorBuild ||
      evidence.snapshot_sha256 !== claim.snapshot.snapshot_sha256 ||
      JSON.stringify(evidence.sealed_media) !== JSON.stringify(media)
    ) throw Error("TRUSTED_SEAL_REQUIRED");
    if (
      locator.bytes > 5 * 1024 * 1024 ||
      locator.width * locator.height > 64000000
    ) throw Error("MEDIA_BOUNDS");
    const response = await options.read(Object.freeze({ ...locator }), signal);
    if (
      signal.aborted || response.status !== 200 || response.redirected ||
      response.headers.get("content-type")?.split(";")[0] !== "image/webp" ||
      !response.body
    ) throw Error("CANONICAL_READ_FAILED");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== locator.bytes) {
      throw Error("MEDIA_LENGTH_MISMATCH");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw Error("MEDIA_CANCELLED");
        const part = await reader.read();
        if (part.done) break;
        total += part.value.length;
        if (total > locator.bytes) throw Error("MEDIA_BOUNDS");
        chunks.push(part.value);
      }
      if (signal.aborted || total !== locator.bytes) {
        throw Error("MEDIA_LENGTH_MISMATCH");
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== locator.sha256) throw Error("MEDIA_DIGEST_MISMATCH");
      return {
        media_id: media.media_id,
        canonicalWebp: bytes,
        integrity: {
          snapshot_sha256: evidence.snapshot_sha256,
          sealed_media: evidence.sealed_media,
          check: {
            check_id: "image_integrity_v2",
            target: { kind: "image", media_id: media.media_id },
            input_sha256: digest,
            state: "passed",
            reason_codes: [],
            retryable: false,
            provider: null,
          },
        },
      };
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
}
