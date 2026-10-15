# FairSwap-Backend

FairSwap is an India-first classifieds marketplace. This repository is the planned
canonical source for FairSwap's shared Supabase backend.

Supabase remains the backend runtime; no standalone API server is planned here.
The approved immutable source baseline has been copied locally in Stage 1B;
deployment authority has not been transferred from FairSwap-Web.

Production and Test Supabase environments must remain untouched during repository
initialization and extraction. Further implementation requires separate approval.

## Stage 1B status

The repository has one README-only initialization commit on `main`. The local
`chore/backend-extraction-baseline` branch contains the accepted Stage 1A
documentation foundation and the authorized 82-file Stage 1B source copy for CTO
review. All feature working-tree changes are unstaged, uncommitted and unpushed.
Toolchain setup, additional test/script migration, CI migration, Web cleanup, and
deployment handoff have not started.

## Approved extraction baseline

- Source: [vivek2310sharma/FairSwap-Web](https://github.com/vivek2310sharma/FairSwap-Web).
- Approved commit: `9e65bfc42eab9697a0a144ed8546afe8309eaea3`.
- Audited source inventory: 58 historical SQL migrations, 10 pgTAP SQL test files,
  and the two production-baseline Edge Functions `process-email-outbox` and
  `process-listing-moderation`.
- The moderation worker depends on `src/lib/moderation/{checker,contract,rules}.ts`.
- Staging-only `process-email-outbox-s1-capture` is excluded from canonical Backend
  extraction. Do not delete or modify the utility in Web.

Preserve existing RPCs, RLS, triggers, grants, Vault worker authentication,
moderation rules, and Web/iOS/Android/Admin consumer compatibility. Web retains
Next.js application code, authentication integration, media HTTP routes, and
Vercel deployment.

The moderation automation switch must remain disabled. No OpenAI moderation,
new approval logic, or business-behavior changes are authorized. The disabled
state is a required invariant, not a claim of a fresh hosted configuration check.

## Review documents

- [Agent boundaries](AGENTS.md)
- [Point 1 baseline and preservation contracts](docs/extraction/POINT1_BASELINE.md)
- [Canonical migration SHA-256 manifest](docs/extraction/MIGRATION_MANIFEST.sha256)
- [Deployment ownership and future handoff](docs/operations/DEPLOYMENT_OWNERSHIP.md)

Stage 1B copied exactly 58 migrations, 10 pgTAP files, one Supabase configuration,
six Edge/shared-worker files, three Auth templates, and four moderation files.
All 82 destination blob identities and Git clean-filter results match the pinned
source. All 58 migration SHA-256 pairs match both the source and accepted Stage 0
manifest. See the baseline document for static verification evidence and limits.

No package manifest, dependencies, JavaScript/TypeScript test suites, operational
scripts, or CI/CD workflows were added. No copied code or runtime tests were run;
source integrity and static path checks do not prove runtime success. No
deployment authority or credentials are provisioned here. Stop after Stage 1B.
