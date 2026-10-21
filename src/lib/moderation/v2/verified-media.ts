/**
 * FairSwap V2 same-project media delivery guard.
 * Does not serve from arbitrary signed URLs. The authenticated/visibility-
 * checked resolver MUST provide the DB-bound expected hash and exact key.
 * The caller must NOT accept the hash or key from a client query param.
 *
 * Note: verifies bytes at read time; not proof against a privileged admin
 * changing bytes after the read or circumventing this delivery path.
 */
export interface TrustedSealedObject {
  readonly key: string;
  readonly bucket: "listing-originals" | "listing-derivatives";
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaId: string;
  readonly listingId: string;
  readonly assetVersion: string;
  readonly variant: "original" | "canonical" | "thumb" | "medium" | "large";
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export interface TrustedReadTransport {
  download(bucket: TrustedSealedObject["bucket"], key: string): Promise<Uint8Array>;
}

export type VerifiedSealedMediaResult =
  | Readonly<{ ok: true; bytes: Uint8Array; mimeType: TrustedSealedObject["mimeType"]; cacheControl: "private, no-store" }>
  | Readonly<{ ok: false; reason: "BAD_EVIDENCE" | "MISSING_BYTES" | "TAMPERED" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
function validEvidence(e: TrustedSealedObject): boolean {
  if (!e || !UUID.test(e.listingId) || !UUID.test(e.mediaId) || !UUID.test(e.assetVersion) ||
      !HASH.test(e.sha256) || !Number.isSafeInteger(e.byteLength) || e.byteLength <= 0 ||
      e.byteLength > 5 * 1024 * 1024) return false;
  const expectedBucket = e.variant === "original" || e.variant === "canonical"
    ? "listing-originals" : "listing-derivatives";
  const expectedMime = e.variant === "original"
    ? e.mimeType : "image/webp";
  if (e.bucket !== expectedBucket || !expectedMime || e.mimeType !== expectedMime) return false;
  const ext = e.variant === "original"
    ? e.mimeType === "image/jpeg" ? "jpg" : e.mimeType === "image/png" ? "png" : "webp"
    : "webp";
  const expectedPath = [e.listingId, e.mediaId, "v2", e.assetVersion,
    e.sha256, `${e.variant}.${ext}`].join("/");
  return e.key === expectedPath;
}

export async function readVerifiedSealedMedia(
  evidence: TrustedSealedObject,
  transport: TrustedReadTransport,
): Promise<VerifiedSealedMediaResult> {
  if (!validEvidence(evidence)) return {ok: false, reason:"BAD_EVIDENCE"};
  let bytes: Uint8Array;
  try {bytes = await transport.download(evidence.bucket, evidence.key);}
  catch {return {ok:false, reason:"MISSING_BYTES"};}
  if (!(bytes instanceof Uint8Array) || bytes.length !== evidence.byteLength || bytes.length > 5 * 1024 * 1024)
    return {ok:false, reason:"TAMPERED"};
  // Snapshot the bytes before the first asynchronous hash operation; a mutable
  // transport buffer must not be able to change after we verified its digest.
  const independentBytes = Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", independentBytes));
  const actual = Array.from(digest).map(x=>x.toString(16).padStart(2,"0")).join("");
  if (actual !== evidence.sha256) return {ok:false, reason:"TAMPERED"};
  return {ok:true, bytes: independentBytes, mimeType: evidence.mimeType, cacheControl:"private, no-store"};
}
