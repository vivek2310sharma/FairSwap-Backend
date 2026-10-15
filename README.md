# FairSwap-Backend

FairSwap is an India-first classifieds marketplace. This repository is the planned
canonical source for FairSwap's shared Supabase backend.

Supabase remains the backend runtime; no standalone API server is planned here.
The approved immutable source baseline has been copied locally in Stage 1B;
deployment authority has not been transferred from FairSwap-Web.

Production and Test Supabase environments must remain untouched during repository
initialization and extraction. Further implementation requires separate approval.

## Stage 2A status

The repository has one README-only initialization commit on `main`. The local
`chore/backend-extraction-baseline` branch has local checkpoint
`47eabc28253951b733f607c61ed08bfa45e60248` for the accepted Stage 1A/1B baseline.
The subsequent Stage 2A toolchain, five unchanged unit tests, verifier and
documentation changes remain unstaged, uncommitted and unpushed for CTO review.
Database integration, CI migration, Web cleanup, and deployment handoff have not
started.

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

## Local unit verification

Use Node `>=24.15.0 <25` and pnpm `10.12.1`. Dependencies are exact pins in the
independent Backend manifest and lockfile; no Next.js or browser test stack.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts --engine-strict
corepack pnpm verify:migrations
corepack pnpm typecheck
corepack pnpm test:unit
```

Stage 2A results on Node 24.15.0: 58 migrations verified, scoped TypeScript passed,
and five unit-test files passed with 93 tests, zero failures/skips/todos. Tests use
fake RPC clients and injected provider transports; the setup blocks real fetch
and socket connections. `envDir: false` prevents automatic environment-file
loading. No hosted initialization, email delivery, or integration suite runs.

TypeScript checks the evaluator/guard, shared worker cores, five tests, setup and
Vitest config. DOM declaration libraries provide the source-compatible Fetch
types; they do not enable jsdom or a browser runtime. Deno entrypoints, SQL/pgTAP,
database behavior, actual Vault authentication and hosted acceptance are not
validated by these unit checks. See the baseline document for exact scope/results.

No deployment authority or credentials are provisioned here. Stop after Stage 2A;
the next stage requires explicit CTO approval.
