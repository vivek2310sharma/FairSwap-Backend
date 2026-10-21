# FairSwap Moderation V2 — Production diagnostic handoff

**Scope:** operator-only OpenAI Moderation **text and image connectivity**, with synthetically generated examples only. **Not** V2 activation, policy approval, user-content moderation, or listing publication.

**Production project:** `kriuhwppxgxsyyrbjsau` (Mumbai). **Test project:** `wpppxlnbzqynvhpeuavd`.

## 1. Confirmed release baseline (21 October 2026)

| Gate | FairSwapProd |
|---|---|
| `moderation_automation_enabled` (V1) | `true` |
| `moderation_v2_enabled` | `false` |
| `moderation_v2_mode` | `disabled` |
| V2 policy registry | 1 entry, `is_approved=false` |
| Text probe | deployed, `verify_jwt=true`, synthetic text mode |
| Image probe before this release | deployed version 2, `verify_jwt=true`, **no synthetic image mode** |
| Approved V2 worker | **not deployed** |

**Never run `supabase db push`, `supabase migration up`, or `supabase functions deploy` without an exact function name during this diagnostic release.** The Backend canonical migration manifest has Test-only history and is not a Production migration promotion plan.

## 2. Deploy the image connectivity probe — separate, manual release

The image synthetic branch was reviewed in merged Backend PR #37, with passing GitHub CI. The deployment command must target **only** `moderation-v2-image-shadow-probe`.

**Preferred path: GitHub Actions**

1. In **FairSwap-Backend → Settings → Environments**, configure `FairSwapProd-moderation-diagnostics`. Require an appropriate reviewer/protection rule; keep this environment separate from ordinary CI.
2. Configure environment-scoped secret `FAIRSWAP_PROD_SHADOW_DEPLOY_TOKEN`: a Supabase management/API token authorized only for the Production project's required Edge Functions deployment permissions. **Do not reuse** the intentionally read-only `FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN`, and do not store the service-role JWT here.
3. Confirm CI has passed on `main`. Under **Actions**, open `[MANUAL] Deploy FairSwapProd V2 image diagnostics`; select `main` and enter `kriuhwppxgxsyyrbjsau`.
4. Approve the protected environment (where required), review the sanitized job summary, and verify in Supabase Production that the image probe has a **new active version** with **`verify_jwt=true`**.
5. Independently confirm V1 and V2 flags remain unchanged using the read-only SQL below.

The workflow uses a CLI archive validated against the repository's exact SHA-256 pin, refuses another actor/branch/project, and runs **only** `supabase functions deploy moderation-v2-image-shadow-probe --project-ref kriuhwppxgxsyyrbjsau`. It does not deploy the V2 worker, run migrations, alter RLS, or change listing rows.

**Alternative: authorized Antigravity/Jules operator session**

In the pinned, reviewed `main` checkout, using Supabase CLI **2.117.0** and a securely injected, project-scoped `SUPABASE_ACCESS_TOKEN`:

```bash
supabase --version
supabase functions deploy moderation-v2-image-shadow-probe --project-ref kriuhwppxgxsyyrbjsau
```

Do **not** pass `--no-verify-jwt`. A management deployment token is different from the function's legacy service-role JWT.

## 3. Owner's synthetic Production tests (no customer content)

On a trusted terminal or secured operator runner, securely supply the existing **legacy Production service-role JWT** to the process environment under the name `SUPABASE_SERVICE_ROLE_KEY`. This credential is not a publishable key, a modern `sb_secret_...` key, a GitHub management token, or an ordinary signed-in user's JWT. The protected endpoints require the legacy JWT at the Supabase gateway **and** an exact service-role bearer comparison inside the function.

Never paste this credential into an issue, PR, browser/mobile app, chat, logs, shell history, or screenshot.

```bash
# Run from FairSwap-Backend, after the image function deployment is verified.
node scripts/moderation/v2-shadow-invoke.mjs check
node scripts/moderation/v2-shadow-invoke.mjs image-check
```

Expected **text** result: `ok=true`, `connected=true`, `mode=check`, `model=omni-moderation-2024-09-26`, `provider=clear`; provider endpoint returns `OPENAI_MODERATION_CONNECTED`.

Expected **image** result: `ok=true`, `connected=true`, `mode=image-check`, the same pinned model and `provider=clear`; provider endpoint returns `OPENAI_IMAGE_MODERATION_CONNECTED`.

A provider result of `flagged` on this intentionally benign fixture indicates connectivity but is **not a release pass** until the false positive is reviewed. Any 401/403/503, `PROVIDER_*` error, wrong model, wrong scope, mismatched authority, or unexpected content fails the release gate. The CLI returns only allowlisted fields.

Both requests send the exact `{"probe":"synthetic_connectivity"}` body. They do **not** read or write a customer listing, photo, database row, or Storage object. Both are **shadow-only** and have no approval/publishing authority.

## 4. Read-only verification SQL

Run in the FairSwapProd SQL Editor and record only the three non-sensitive rows:

```sql
select setting_key, setting_value
from public.app_system_settings
where setting_key in (
  'moderation_automation_enabled',
  'moderation_v2_enabled',
  'moderation_v2_mode'
)
order by setting_key;
```

Required invariants before **and after** the diagnostic deployment:

- `moderation_automation_enabled = true` (V1 stays on)
- `moderation_v2_enabled = false`
- `moderation_v2_mode = disabled`

Never change these settings as part of a connectivity check.

## 5. Why full V2 publication is NOT in scope

| Verified comparison | Production | Test |
|---|---:|---:|
| V2 internal tables | 5 | 17 |
| V2 RPC functions | 13 | 54 |
| V2 schema RLS policies | 0 | 41 |
| deployed `process-listing-moderation-v2` | no | yes, Test-only synthetic entrypoint |

Additional Test structures include `seal_objects`, `seal_bundles`, `seal_media_bindings`, `p3_evaluation_evidence`, and the guarded evaluator/finalizer RPCs. The Test worker requires Test-specific credentials, a restricted DB role, and a pinned fixture package; it cannot be redeployed unchanged to Production.

**Mandatory before a separate V2 automation release:** commit source-controlled migrations with strict provenance; reconstruct and test from Production baseline in an isolated PG15 environment; verify sealed-media lineage, tamper/invalidation rules, idempotency and claim leases, seller/status controls, reviewer appeals, policy approval and immutable evidence; test Indian UPI QR/OTP, advance-payment, defence-personnel and courier scams in Hindi, Hinglish and English; verify RLS and function privileges; approve guarded cutover and rollback separately. Passing free OpenAI Moderation calls is **not** a fraud-safe or publication-safe launch.

**Security advisor triage:** Production currently reports callable `SECURITY DEFINER` functions. Fourteen of the fifteen observed are trigger/event-trigger return types (not normal direct RPC invocations); the remaining scalar visibility helper requires a caller/dependency review. Do not issue a blanket `REVOKE EXECUTE` without testing the triggers, RLS and frontend behavior. Review mutable search paths and `pg_net` extension notices independently.

## 6. Failed test or deployment: containment and rollback

1. Do not enable V2, approve policy, or process customer listings. Leave V1 active.
2. Preserve only sanitized response codes, function version, and CI/Actions run identifiers. Never retain credentials, provider raw payloads, image bytes, or seller text.
3. For a diagnostic-function regression, stop invoking the endpoint and redeploy/restore the last reviewed image shadow function version through the same authorized operator process. Verify `verify_jwt=true` afterward. **Do not roll back database schema to revert a diagnostic function.**
4. Recheck the three flags above and existing V1 queue behaviour. Any unexpected change needs incident triage before a second deployment.

## 7. Gate ledger

- [x] Image synthetic fixture and SHA-256 verification covered by offline CI.
- [x] PR #37 merged with green Backend CI.
- [x] Manual deploy-only pathway defined with exact Production target and separate credentials.
- [ ] Manual image-probe **deployment** completed and Production function version verified.
- [ ] Operator text `check` returns expected sanitized 200.
- [ ] Operator image `image-check` returns expected sanitized 200.
- [ ] Full V2 worker, schema, policy and staged fraud/security acceptance approved (separate release).

**FairSwap policy:** prioritize low fraud and correct review over premature automation. This gate protects Indian buyers and sellers from UPI/OTP, fake-courier and impersonation scams while preserving V1.
