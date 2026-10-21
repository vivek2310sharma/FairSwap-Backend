# Emergency Production hotfix: Moderation V2 operator shadow JWT (21 October 2026)

## Issue

The Production **text and image operator shadow probes**, both at function version 3,
returned `401 UNAUTHORIZED` from **inside the handlers** for an incoming Production
legacy `service_role` JWT. The operator verified offline that the token carries
`role=service_role`, Production `ref=kriuhwppxgxsyyrbjsau`, has no whitespace,
and is not expired. Supabase's platform `verify_jwt=true` gateway permitted the
requests to execute. The existing handlers rejected the token because they compared
the exact bearer bytes to the function's managed legacy
`SUPABASE_SERVICE_ROLE_KEY`, which need not equal every gateway-accepted
service-role JWT (e.g. following key changes).

## Scope of fix

**Authentication:** Keep platform **cryptographic JWT signature verification
enabled** on BOTH Edge Functions. Once the gateway has accepted the token, check
the signed **legacy HS256 JWT** claims inside the handler: Production project ref,
`role=service_role`, valid expiration, valid issuance/not-before, bounded JWT
parts. Reject user/anon/wrong-project/expired/malformed JWTs before any DB,
Storage or provider operation. This does NOT enable public access. These handlers
MUST NEVER be deployed with `verify_jwt=false` and the local claims helper
MUST NEVER be treated as an independent cryptographic JWT verifier.

**Behaviour:** The read-only synthetic text + image probes remain unable to
publish, approve, write DB rows, read customer data for synthetic checks, or
turn on Moderation V2. The existing service-role runtime credential is still
used for any separately requested, read-only listing or media shadow access;
the hotfix does not rotate or replace Supabase managed secrets.

## Release gate and execution (owner only)

1. Review this PR's **unit-integrity and isolated PG15 CI** results. Must be green.
2. Verify `supabase/config.toml` sets `verify_jwt = true` for BOTH:
   `moderation-v2-text-shadow-probe`, `moderation-v2-image-shadow-probe`.
3. Merge to `main` only when green and review confirms no change to
   automatic V1/V2 dispatch or policy activation.
4. Open **GitHub Actions**:
   `https://github.com/vivek2310sharma/FairSwap-Backend/actions/workflows/backend-prod-v2-image-shadow-deploy.yml`.
   The existing, manually triggered, owner-only, protected environment
   `FairSwapProd-moderation-diagnostics` (already configured in Phase 1) will
   deploy **BOTH shadow probes, and no other function**, using
   `FAIRSWAP_PROD_SHADOW_DEPLOY_TOKEN`. Input exact Production ref
   `kriuhwppxgxsyyrbjsau`. No `--no-verify-jwt`. Do NOT deploy Test's
   synthetic V2 worker and do NOT run DB migrations in this hotfix.
5. Verify both functions in FairSwapProd Edge Functions became version 4+
   and still have `verify_jwt=true`.
6. In the **trusted WSL operator terminal**, using the existing securely supplied
   legacy Production `service_role` JWT (never copy into chat or logs):
   ```bash
   node scripts/moderation/v2-shadow-invoke.mjs check
   node scripts/moderation/v2-shadow-invoke.mjs image-check
   unset SUPABASE_SERVICE_ROLE_KEY
   ```
   Both must yield `ok=true`, `connected=true`, `provider=clear`.
   Any `flagged` synthetic fixture requires review, not silent release.
   If 503 occurs, record only the sanitized response code/reason to debug
   OpenAI configuration. A 401 means keep the release gated.
7. Recheck `app_system_settings`: `moderation_automation_enabled=true`,
   `moderation_v2_enabled=false`, `moderation_v2_mode=disabled`.

## Non-goals: full V2 activation

This release is diagnostic connectivity, **not** authoritative Moderation V2.
Production still lacks Test's V2 P3 sealed-media, guarded finalizer, worker roles
and policy-approved stage. A green synthetic connectivity check does not prove
India marketplace fraud detection, anti-OTP/UPI protections, media integrity,
end-to-end moderation safety or publication controls. These remain separate
Production promotion gates, with V1 authoritative in the meantime.

## Containment

If anything fails, leave V1 enabled and V2 disabled, stop running tests,
and revert the two shadow functions to the previous verified source through
the protected deployment path. Never disable gateway JWT verification, expose
service-role keys to web/mobile, alter default Supabase-managed secrets,
or indiscriminately run Test migrations on Production.
