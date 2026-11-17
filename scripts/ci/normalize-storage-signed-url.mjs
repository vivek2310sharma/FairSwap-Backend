/**
 * Normalizes and validates a Supabase Storage signed URL for the FairSwap Moderation Controller.
 *
 * Controller origin validation requirements:
 * 1. Protocol must be HTTPS.
 * 2. Hostname must match allowed Supabase host (e.g. wpppxlnbzqynvhpeuavd.supabase.co).
 * 3. Pathname must include /storage/v1/object/sign/listing-originals/
 * 4. Query string must contain a non-empty token parameter.
 *
 * Supported raw signedURL formats from Supabase Storage REST:
 * - Relative REST path: /object/sign/listing-originals/<path>?token=...
 * - Relative prefixed path: /storage/v1/object/sign/listing-originals/<path>?token=...
 * - Absolute HTTPS URL: https://<projectRef>.supabase.co/storage/v1/object/sign/listing-originals/<path>?token=...
 * - Absolute HTTPS URL without /storage/v1: https://<projectRef>.supabase.co/object/sign/listing-originals/<path>?token=...
 */

export function normalizeStorageSignedUrl(projectRef, storageObject, rawSignedUrl) {
  if (!projectRef || typeof projectRef !== "string" || !/^[a-z0-9_-]+$/i.test(projectRef)) {
    throw new Error(`Invalid projectRef: ${projectRef}`);
  }
  if (!rawSignedUrl || typeof rawSignedUrl !== "string" || rawSignedUrl.trim().length === 0) {
    throw new Error("Missing or empty signed URL");
  }

  const expectedHost = `${projectRef.toLowerCase()}.supabase.co`;
  const expectedBucket = "listing-originals";

  let parsed;
  try {
    if (rawSignedUrl.startsWith("http://") || rawSignedUrl.startsWith("https://")) {
      parsed = new URL(rawSignedUrl);
      if (parsed.protocol !== "https:") {
        throw new Error(`Forbidden protocol '${parsed.protocol}', HTTPS is strictly required`);
      }
      if (parsed.hostname.toLowerCase() !== expectedHost) {
        throw new Error(`Unexpected hostname '${parsed.hostname}', expected '${expectedHost}'`);
      }
    } else {
      if (!rawSignedUrl.startsWith("/")) {
        throw new Error(`Relative signed URL path must begin with '/': ${rawSignedUrl}`);
      }
      parsed = new URL(rawSignedUrl, `https://${expectedHost}`);
    }
  } catch (err) {
    throw new Error(`Malformed signed URL: ${err.message}`);
  }

  // Verify non-empty token
  const token = parsed.searchParams.get("token");
  if (!token || token.trim().length === 0) {
    throw new Error("Signed URL is missing required 'token' query parameter");
  }

  // Canonicalize path: strip /storage/v1 prefix if present to inspect clean REST path
  let path = parsed.pathname;
  if (path.startsWith("/storage/v1/")) {
    path = path.slice("/storage/v1".length);
  }

  const expectedPrefix = `/object/sign/${expectedBucket}/`;
  if (!path.startsWith(expectedPrefix)) {
    throw new Error(`Signed URL path does not target expected bucket '${expectedBucket}': ${parsed.pathname}`);
  }

  // If storageObject specified, verify that the object key in the path matches
  if (storageObject) {
    const expectedKey = storageObject.replace(/^\/+/, "");
    const actualKey = path.slice(expectedPrefix.length);
    if (actualKey !== expectedKey) {
      throw new Error(`Signed URL object key '${actualKey}' does not match expected key '${expectedKey}'`);
    }
  }

  // Construct canonical URL without double prefixing
  const canonicalPath = `/storage/v1${path}`;
  const canonicalUrl = new URL(canonicalPath, `https://${expectedHost}`);
  canonicalUrl.search = parsed.search;

  return canonicalUrl.toString();
}

// CLI execution helper
if (process.argv[1] && process.argv[1].endsWith("normalize-storage-signed-url.mjs")) {
  const [,, projectRef, storageObject, rawSignedUrl] = process.argv;
  if (!projectRef || !rawSignedUrl) {
    console.error("Usage: node normalize-storage-signed-url.mjs <projectRef> <storageObject> <rawSignedUrl>");
    process.exit(1);
  }
  try {
    const normalized = normalizeStorageSignedUrl(projectRef, storageObject, rawSignedUrl);
    process.stdout.write(normalized);
  } catch (err) {
    console.error(`::error::Storage signed URL normalization failed: ${err.message}`);
    process.exit(1);
  }
}
