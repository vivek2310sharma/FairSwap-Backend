# Point 1 extraction baseline

## Authorization and repository provenance

Stages 0, 1A and 1B are accepted. Stage 1A initialized the existing private
repository `vivek2310sharma/FairSwap-Backend`. Stage 1B copied and verified the 82
immutable source files. Stage 2A authorizes one local baseline checkpoint plus an
independent unit-test toolchain, five unchanged pinned unit-test copies, a read-only
migration verifier and scoped local verification. No database integration,
CI/deployment ownership transfer or Web cleanup is authorized.

| Item | Approved value |
| --- | --- |
| Source repository | `vivek2310sharma/FairSwap-Web` |
| Exact source commit | `9e65bfc42eab9697a0a144ed8546afe8309eaea3` |
| Destination repository | `vivek2310sharma/FairSwap-Backend` |
| Initial main commit | `02ca486f903fb87e48da215bd1e6569fea14af1b` |
| Initial commit message | `chore: initialize FairSwap backend repository` |
| Local review branch | `chore/backend-extraction-baseline` |
| Feature branch base | Same initial main commit |
| Local Stage 1A/1B checkpoint | `47eabc28253951b733f607c61ed08bfa45e60248` |

The remote was verified empty before Stage 1A initialization. The authorized
README-only initial commit is the only commit on main. Stage 2A created one local
checkpoint on the feature branch with message
`chore(backend): import verified Supabase source baseline`. Its 88-file tree
preserves all 82 canonical source blobs. Subsequent Stage 2A working-tree changes
remain unstaged, uncommitted and unpushed for CTO review. No remote writes are
authorized or performed in Stage 1B/2A. Do not repeat initialization.

Older/dirty local Web checkouts are not extraction sources. Future source reads
must use the exact approved commit, with any newer baseline separately reviewed.

## Audited inventory and immutable source copy

| Source path | Accepted audit inventory / dependency |
| --- | --- |
| `supabase/migrations/` | 58 historical SQL migrations |
| `supabase/tests/` | 10 pgTAP SQL test files |
| `supabase/config.toml` | Supabase local runtime/Auth/function configuration |
| `supabase/templates/` | Confirmation, sign-in OTP, and recovery templates |
| `supabase/functions/process-email-outbox/` | Production-baseline delivery worker |
| `supabase/functions/process-listing-moderation/` | Production-baseline moderation worker |
| `supabase/functions/_shared/email-outbox-worker.ts` | Email claim/render/retry/persistence core |
| `supabase/functions/_shared/listing-moderation-worker.ts` | Moderation claim/evaluate/finalize core |
| `src/lib/moderation/` | Worker evaluator: `checker.ts`, `contract.ts`, `rules.ts`; integration guard: `target-guard.ts` |

The ten pgTAP files are:

1. `admin_medium_operation.test.sql`
2. `admin_reviewed_contract.test.sql`
3. `listings_insert_category_eligibility.test.sql`
4. `moderation_vault_dispatch_auth.test.sql`
5. `pending_review_media_invalidation.test.sql`
6. `schema_email_outbox.test.sql`
7. `schema_listings.test.sql`
8. `schema_post_ad_category_metadata.test.sql`
9. `schema_security.test.sql`
10. `seller_listing_category_context.test.sql`

The accepted Stage 0 conversation report contains the full 58-file SHA-256
manifest. Stage 1B independently recomputed all 58 hashes from pinned Git blob
bytes and compared them with both the copied files and the retained Stage 0 audit
manifest: 58/58 match, with no discrepancies. The conventional, path-sorted
`MIGRATION_MANIFEST.sha256` contains all 58 repository-relative migration paths.
Its own SHA-256 is
`eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd`.

Stage 1B used a separate temporary bare clone of the credential-free Web remote,
outside existing project repositories. The source commit was resolved to the exact
approved SHA before reading its tree. Raw `git cat-file blob` byte buffers were
written directly with exclusive creation; no source checkout filters or text copy
operations were used, and no existing destination file was overwritten.

For all 82 files, canonical Git blob SHA-1 was reconstructed against the pinned
tree, destination bytes matched source bytes/SHA-256, and non-writing
`git hash-object --path=<destination-path> --stdin` matched the same blob after
destination clean filters. All checks passed. Local `core.autocrlf=true` did not
change clean-filter identities. No `.gitattributes`, Git configuration, or
`.gitignore` change was needed. No files were staged for verification.

Exact copied counts: 58 migrations + 10 pgTAP tests + 1 configuration + 6
Edge/shared-worker files + 3 Auth templates + 4 moderation evaluator/guard files
= 82. Stage 1A documents were byte-preserved during copying and then narrowly
updated to reflect Stage 1B; `.gitignore` remains unchanged.

Committed source is not evidence of deployment approval or hosted migration
history. Preserve all historical files, including Test-named migrations, without
automatically applying them to any environment.

## Explicit exclusion

Staging-only `process-email-outbox-s1-capture` and its shared implementation/tests
are excluded from canonical Backend extraction. They are not production-baseline
delivery behavior. This decision does not authorize deleting or modifying them in
Web, deploying them, or changing any Test capture configuration.

## Security and behavior contracts

- Keep RPC signatures, parameter names, overloads, grants, return structures, and
  error codes compatible. Preserve both `seller_submit_listing` overloads and
  `moderate_listing_reviewed` revision/status validation, including `PT409`.
- Preserve RLS, trigger behavior, public-invoker/private-definer boundaries,
  security-definer search paths, ownership checks, active-account checks, policy
  acceptance, staff AAL2, and self-review prohibitions.
- Preserve listing status transitions, media readiness/ownership requirements,
  review revision invalidation, queue generation/lease checks, and atomic
  finalization. Do not restore the revoked unversioned moderation bypass.
- Preserve Vault-authenticated moderation dispatch and its service-role-only
  boolean verification RPC. Verification failure must deny before queue claims.
- Preserve existing text rules, ruleset `prototype_v0.1.1`, evaluation scope
  `title_description`, and all four evaluator outcomes. No OpenAI moderation, new
  approval logic, or business-behavior changes are authorized.
- The `moderation_automation_enabled` switch must remain disabled. No hosted
  inspection or toggle is authorized; this document does not certify live state.
- Preserve email outbox deduplication, idempotency, retry/lease recovery,
  transactional isolation, and cron contracts. No synthetic real-mail delivery.
- Preserve postal provenance, location privacy, private originals, derivative
  access authorization, and consumer-facing security responses.

## Consumer and ownership boundaries

Web, iOS, Android, and Admin contracts must remain compatible. Native clients
consume `seller_submit_listing(listing_id)` and Web media HTTP routes. Admin
consumes reviewed moderation with expected revision/status and `PT409` handling.
No API URLs, listing status values, media response shapes, or security responses
are to change through extraction.

Web retains Next.js application code, authentication/session integration, media
HTTP routes, and Vercel deployment. Its generated `src/types/database.ts` remains
a consumed artifact; later generation/distribution needs a reviewed contract.
The evaluator has no inspected Web runtime consumer, but worker/tests depend on
its existing paths. Preserve the initial relative layout where practical.

Deployment authority remains with the existing Web/operator arrangement, subject
to separate release approval. Backend has no deployment authority. See
`../operations/DEPLOYMENT_OWNERSHIP.md`.

## Verification carried forward

Stage 0 inspected source and computed hashes; it did not run test suites. Existing
CI excludes `schema_email_outbox.test.sql`, and its PG17 historical rehearsal uses
41 rather than all 58 migrations. MOD integration and Post Ad SQL require explicit
disposable-local opt-ins and run-identity fixtures. These gaps remain unresolved.

Stage 1A verified repository identity, the single initial commit, local/remote main
agreement, feature base, and the five documentation/configuration files. Stage 1B
reverified that baseline and copied only the authorized source inventory.

Static checks resolved all relative TypeScript imports in copied files, both
entrypoints' shared-worker imports, and Deno import-map targets. Both import maps
retain Supabase JS `2.116.0` and Zod `3.24.2`. All three config `content_path`
references resolve to copied templates. Exactly two deployable function
directories exist, with no S1 capture source. Credential-pattern inspection found
no private keys, recognizable live token strings, JWT literals, or credential-bearing
connection URLs in the copied baseline; configuration environment-variable names
are not secret values. Pattern inspection cannot certify every possible secret
format.

At the Stage 1B closeout, no relative-file dependency was missing. Package resolution, Deno/TypeScript
compilation, extension availability, SQL execution, actual Auth callbacks, worker
runtime behavior, and live switch state remain unverified. No packages were
installed and no copied code, tests, workers, operational scripts, database
reconstruction, hosted Supabase operation, or deployment was executed. Existing
Web, Admin and mobile repositories are outside the write scope.

## Stage 2A local verification (15 October 2026)

Pre-commit integrity verified 82/82 raw source and staged blob identities, all 58
migration hashes, and manifest SHA-256
`eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd`.
The exact reviewed 88 files were checkpointed locally. `git diff --cached --check`
reported inherited trailing whitespace in five SQL migrations and a blank EOF
line in `supabase/config.toml`; those immutable source bytes were preserved.

The toolchain uses Node 24.15.0, pnpm 10.12.1, Supabase JS 2.116.0, Zod 3.24.2,
TypeScript 5.9.3, Vitest 3.2.7 and the source-audited Node declarations 20.19.43.
Registry engine checks establish Node compatibility; frozen installation with
`--ignore-scripts --engine-strict` passed. The independent package is
`fairswap-backend`. It has no Next.js/jsdom dependency, deployment script, Web
server-only stub, or Supabase CLI. Before a package pin existed, Corepack's version
probe cached pnpm 12.11.2; actual installation and checks use 10.12.1. No project
dependency was upgraded. pnpm emits a Node `url.parse()` deprecation warning.

All five unit tests were copied byte-for-byte from the approved Web commit using
an isolated temporary bare clone. No expectations or production code changed.
Test inspection verified fake RPC/Auth clients and injected provider transports;
Request/Response objects and URLs are in-memory fixtures, not real requests.
The separate test setup blocks global fetch and socket connections and asserts
zero network attempts after each test. Explicit discovery selects only these five
files, Node is the environment, zero-test success is disabled, and `envDir: false`
prevents automatic environment-file loading.

| Exact test path | Discovered / executed / passed | Failed / skipped |
| --- | --- | --- |
| `src/__tests__/moderation-text-checker.test.ts` | 39 / 39 / 39 | 0 / 0 |
| `src/__tests__/moderation-target-guard.test.ts` | 7 / 7 / 7 | 0 / 0 |
| `src/__tests__/moderation-worker.test.ts` | 10 / 10 / 10 | 0 / 0 |
| `src/__tests__/moderation-worker-vault-auth.test.ts` | 3 / 3 / 3 | 0 / 0 |
| `tests/unit/email-outbox-worker.test.ts` | 34 / 34 / 34 | 0 / 0 |
| Total | 93 / 93 / 93 | 0 / 0 |

Executed commands and results:

- `corepack pnpm verify:migrations`: PASS, exactly 58 files. The new Node verifier
  reads byte hashes, validates count/format/unique sorted paths and exact disk SQL
  membership, and never writes migrations. One positive disposable fixture and
  seven negative cases (altered bytes, missing/additional file, malformed entry,
  duplicate path, unsorted paths, wrong count) passed. Fixture files were removed.
- `corepack pnpm typecheck`: PASS after a configuration-only Fetch declaration
  correction. The initial ES2022-only run found `Response.json()` typed as unknown
  by Node declarations; adding DOM/DOM.Iterable libraries restores the standard
  Fetch declaration contract used by the source. Strict mode remains enabled.
- `corepack pnpm test:unit --reporter=verbose --reporter=json
  --outputFile=artifacts/stage2a-unit-results.json`: PASS, five files, 93 tests,
  zero failed/pending/skipped/todo. The machine report is ignored local evidence.
- Final rerun with `--reporter=default --reporter=json` also passed 93/93. A
  restricted-sandbox attempt failed before test discovery because esbuild could
  not read parent directories; the approved filesystem-access rerun passed with
  the same no-network harness. This was a runner restriction, not a test failure.

TypeScript includes evaluator/guard, both shared worker cores, the five copied
tests, network setup and Vitest config. It excludes the Deno entrypoint directories
and does not check SQL, templates or the JavaScript verifier through tsc. The
verifier was executed directly. DOM types are declarations only; tests remain Node
and do not run a DOM/browser. No Deno compiler/runtime check has been performed.

Remaining gaps: SQL reconstruction, all pgTAP (including the known excluded email
test), actual queue/RLS/Vault behavior, Edge runtime, PostgreSQL 17 full-chain
rehearsal, hosted Auth/media/consumer acceptance and live switch state remain
unverified. Mocked auto-approval results do not activate or prove real publication.
No runtime database suite, hosted Supabase operation, worker deployment or real
email was executed. Deployment authority and automation settings remain unchanged.

Stop after Stage 2A for CTO review. Do not commit subsequent toolchain changes,
push, open a PR, or begin Stage 2B/database integration, additional test/script
migration, CI migration, Web cleanup, or ownership transfer without approval.
