# Deployment ownership

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
| Backend CI/CD deployment jobs, credentials, or permissions | None introduced by Stage 1A or Stage 1B |
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

None of these operational handoff steps is authorized by Stage 1A or Stage 1B. No environment
or feature activation is implied. Production-baseline workers remain
`process-email-outbox` and `process-listing-moderation`; S1 capture is not a
Production deployment target.
