/**
 * Application-level claim restriction for the FairSwapProd shadow probes.
 *
 * CRITICAL TRUST BOUNDARY: Supabase's Edge Functions gateway MUST validate
 * the JWT signature and expiry before reaching these handlers
 * (verify_jwt = true in config.toml AND the deployed function metadata).
 *
 * This helper DOES NOT verify a JWT signature, and MUST NOT be used as an
 * authentication mechanism in a publicly reachable function with JWT
 * verification disabled. We only read the claims of a gateway-verified,
 * legacy HS256 service_role JWT. Ordinary signed-in users, anon JWTs,
 * missing/expired tokens and non-Production tokens fail closed.
 *
 * Replaces comparing to Deno.env.SUPABASE_SERVICE_ROLE_KEY byte-for-byte:
 * Supabase's managed legacy secret may not be identical to a separately
 * issued, gateway-accepted service_role JWT after JWT-key migration.
 */
const PROD_REF = "kriuhwppxgxsyyrbjsau";
const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeJwtSegment(segment: string, maxLength: number): unknown {
  if (!segment || segment.length > maxLength || !B64URL.test(segment)) return null;
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

export function hasProductionServiceRoleClaims(
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const bearer = request.headers.get("authorization");
  if (!bearer || !bearer.startsWith("Bearer ") || bearer.length > 4096) return false;
  const token = bearer.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[2].length < 40 ||
      parts[2].length > 512 || !B64URL.test(parts[2])) return false;
  const header = decodeJwtSegment(parts[0], 512);
  const payload = decodeJwtSegment(parts[1], 2048);
  if (!header || typeof header !== "object" ||
      (header as Record<string, unknown>).alg !== "HS256" ||
      !payload || typeof payload !== "object" ||
      Array.isArray(payload)) return false;
  const claims = payload as Record<string, unknown>;
  return claims.role === "service_role" &&
    claims.ref === PROD_REF &&
    typeof claims.exp === "number" &&
    Number.isFinite(claims.exp) &&
    claims.exp > nowSeconds &&
    (claims.nbf === undefined ||
      (typeof claims.nbf === "number" && claims.nbf <= nowSeconds)) &&
    (claims.iat === undefined ||
      (typeof claims.iat === "number" && claims.iat <= nowSeconds));
}
