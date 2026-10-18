# Deployment ownership

> **18 October 2026 status:** Shared backend source is canonical in FairSwap-Backend; Web `main` and `staging` **no longer track the 58 migration SQL files and 10 pgTAP SQL files** (verified CI/Preview). The Web-only backend **deployment-credential revocation and Backend exclusive authority grant are NOT YET VERIFIED**. See [exclusive owner cutover runbook](BACKEND_ONLY_RELEASE_CUTOVER.md). A repository cleanup or GitHub App Contents-read grant does not confer Supabase deploy authority.

## Production status update (18 October 2026; no ownership transfer)

The hidden Cars/Two-Wheelers/Property database foundation was applied by an explicitly authorized manual Supabase CLI operator on 18 October 2026 (UTC completion 17 October 22:45:51). FairSwapProd's verified migration history is now **52 versions**. [Deployment receipt](../../releases/production/category-foundation-v1/production-deployment-20261018.json).

This did **not** transfer Web/Backend deployment credentials or create a Backend deployment job. The original 58-file mixed-environment source directory must **not** be pushed raw to Production; use the isolated, verified 52-version Production baseline and approved forward-only migrations. The Stage 1A/1B/2A scope restrictions below describe historical extraction authorization and should not be mistaken for the current live database state.

## Current authority: unchanged

FairSwap-Backend is the planned canonical source for FairSwap's shared Supabase
backend. Supabase remains the runtime; this repository introduces no standalone
API server. Stage 1B copied the immutable approved source baseline locally;
deployment authority has not transferred from Web to Backend. Copying source is
not an operational handoff or authorization to execute it.

| Surface | Current boundary |
| --- | --- |
| Next.js application, authentication integration, media HTTP routes | Web |
| Vercel Web application deployment | Web; unchanged by extraction |
| Shared Supabase migrations, RPCs, RLS, grants, triggers, Storage/Auth/Edge configuration | Existing Web/operator release arrangement; no Backend authority yet |
| Production and Test Supabase projects | Untouched during repository extraction |
| Backend CI/CD deployment jobs, credentials, or permissions | None introduced by Stages 1A, 1B or 2A |
| Staging-only S1 capture | Excluded from canonical Backend extraction; no deletion or deployment authorized |

This is an ownership boundary, not proof that every existing external integration,
manual credential, repository permission, or hosted deployment setting has been
audited. Stage 0 did not inspect live hosted configuration. Existing deployment
capability does not itself authorize a release.

## Extraction restrictions

No hosted Production or Test changes during repository extraction. Do not run
migrations, reset databases, deploy Edge Functions, alter Auth/Storage/Vault,
connect/create projects, transfer credentials, or add deployment workflows or
permissions. No implicit deployment from a merge or source-file copy.

The moderation automation switch must remain disabled. Do not inspect or toggle
it under extraction authorization. Preserve existing RPCs, RLS, triggers, grants,
Vault authentication, moderation rules, and consumer compatibility. No OpenAI
moderation, new approval logic, or business-behavior changes.

## Future handoff proposal: separate approval required

1. Prepare and verify Backend source and local CI without deployment credentials
   or enabled deployment workflows. Preserve migration hashes/provenance and
   Web/iOS/Android/Admin contracts.
2. Under separate operational authorization, inventory actual Web/manual/external
   deployment paths and each environment's migration/function state. Establish a
   release freeze and record the last Web-owned release revision.
3. Revoke or disable Web backend deployment authority and verify that revocation,
   including manual credentials and integrations. Retain Web application/Vercel
   deployment authority.
4. Only after verified revocation, grant reviewed, environment-scoped Backend
   deployment authority with explicit approvals and rollback/forward-fix evidence.
5. Verify sole ownership and update runbooks/consumer contracts. Never temporarily
   grant duplicate backend deployment authority to Web and Backend.

Stage 2A permits only local checkpoint/toolchain/unit verification; it does not
authorize database or hosted integration. None of these operational handoff steps
is authorized by Stages 1A, 1B or 2A. No environment
or feature activation is implied. Production-baseline workers remain
`process-email-outbox` and `process-listing-moderation`; S1 capture is not a
Production deployment target.
