# OpenAI text + image moderation gate release — 22 October 2026

## Authorization and scope
Owner approved deploying to **FairSwapTest** and **FairSwapProd**. Owner will conduct Production OpenAI/live-image and editing/attachment tests. Preserve `moderation_automation_enabled=true`; **no keyword/regex rule changes** and no change to `moderation_v2_enabled=false`.

## Environment receipt (manual Supabase MCP operator deployment)
| Property | FairSwapTest | FairSwapProd |
| --- | --- | --- |
| Supabase project | `wpppxlnbzqynvhpeuavd` | `kriuhwppxgxsyyrbjsau` |
| Database migration | `moderation_v1_openai_text_image_publication_gate` | `moderation_v1_openai_text_image_publication_gate` |
| `process-listing-moderation` version | 16 | 4 |
| Edge deployment `ezbr_sha256` | `aeb1f1c84a236612be413992c485eca282071ed0906a006cfdd14c81645098df` | `aeb1f1c84a236612be413992c485eca282071ed0906a006cfdd14c81645098df` |
| `verify_jwt` | false — worker Vault authentication remains mandatory | false — worker Vault authentication remains mandatory |
| Automation setting | `true` (unchanged) | `true` (unchanged) |
| V2 experimental switch | `false` (unchanged) | `false` (unchanged) |

Migration source: `supabase/forward-migrations/moderation-v1/20261022_openai_text_image_publication_gate.sql`.
Edge worker source: PR #42 branch `fix/moderation-v1-image-gun-nudity-gate-20261021`.

## Verification performed
- Both Edge deployment responses `ACTIVE`, exact same bundle SHA, correct versions.
- Both DB finalizers now call `app_security.impl_has_current_openai_clear_evidence(...)` on the clean automatic-publishing path.
- Both settings retain `moderation_automation_enabled=true`.
- `public.record_listing_openai_clear_evidence`: `anon` and `authenticated` EXECUTE **false**, `service_role` EXECUTE **true**.
- Missing attestation returns **false** in both DBs.
- Prior production and test finalizers backed up under `app_security.moderation_ai_gate_release_backup` with original source sizes 18,964 and 27,265 bytes respectively.
- Negative malformed-evidence write Test returned `{success:false,error:'MEDIA_COUNT_INVALID'}`.
- Offline Backend **unit-integrity CI passed** on changed release candidate. Full PG15/database CI still pending at release observation.

## Unverified / known limitations
1. No end-to-end OpenAI content test or OpenAI secret/billing probe was executed. If `OPENAI_API_KEY` is absent, invalid, or provider fails, the worker **does not** submit a clean attestation and listings remain non-auto-published, eventually requiring human review.
2. Existing Storage media keys are *mutable to privileged writers*. Evidence binds the DB manifest, text revision and SHA-256 of bytes read during worker evaluation, **not immutable object lock**. A privileged in-place Storage object overwrite between check and public serving can escape this V1 gate. This remains a high-priority V2 immutable-seal / Storage-enforcement work item.
3. The worker checks the medium WebP derivative for *every attached media row*, not the full-resolution immutable V2 canonical image. Small details and classification accuracy are not guaranteed.
4. Moderation records retain V1 `title_description` scope and `prototype_v0.1.1` database contract for backward compatibility, with separate private AI evidence.
5. Existing active/previously auto-approved listings were not re-scanned or automatically removed. Manual review of the incident test listings still recommended.
6. Code is on PR #42; deployment does not imply GitHub branch merge or final Backend deployment-authority handoff.

## Owner's Production smoke checks
1. With a safe listing and 1–8 legitimate photographs, ensure automatic approval works; if held, investigate OpenAI key/provider, image derivative readiness, Edge lease, and request outcome.
2. Submit a benign-looking title with a clearly prohibited firearm or nude image: it must NOT become active and must be routed to Admin (when OpenAI/provider operates).
3. Change title, description, attached image, or image order during moderation. Stale evidence must NOT allow the changed content to publish. Re-submit to start a fresh check.
4. Verify Admin manual approvals still work and that existing user/seller listing workflows do not bypass the gate.

## Forward-fix / rollback
Never revert only the SQL publication gate while leaving text-only V1 auto-approval active.
- For OpenAI-provider incidents, keep the new SQL gate. Automatic clearance fails closed while staff can review.
- Prior finalizer DDL is stored in each project's private backup table, but restoring it would **re-enable text-only auto-publication** and requires a separate explicitly reviewed safety plan.
- The prior worker source remains available in Backend `main`; redeploy only alongside a reviewed fail-closed SQL gate.
- Deployments and migration were manually authorized for these two projects; they did not transfer deploy ownership to Backend CI.
