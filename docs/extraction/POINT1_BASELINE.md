# Point 1 extraction baseline

## Authorization and repository provenance

Stages 0 and 1A are accepted. Stage 1A initialized the existing private repository
`vivek2310sharma/FairSwap-Backend`. Stage 1B authorizes only immutable source copy,
integrity/static verification, the migration manifest, and necessary documentation
updates. The 82-file source copy is complete locally and ready for CTO review;
runtime behavior has not been tested.

| Item | Approved value |
| --- | --- |
| Source repository | `vivek2310sharma/FairSwap-Web` |
| Exact source commit | `9e65bfc42eab9697a0a144ed8546afe8309eaea3` |
| Destination repository | `vivek2310sharma/FairSwap-Backend` |
| Initial main commit | `02ca486f903fb87e48da215bd1e6569fea14af1b` |
| Initial commit message | `chore: initialize FairSwap backend repository` |
| Local review branch | `chore/backend-extraction-baseline` |
| Feature branch base | Same initial main commit |

The remote was verified empty before Stage 1A initialization. The authorized
README-only initial commit is the only commit on main. All feature working-tree
changes remain unstaged, uncommitted and unpushed for CTO review. No remote writes
are authorized or performed in Stage 1B. Do not repeat initialization.

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

No relative-file dependency was missing. Package resolution, Deno/TypeScript
compilation, extension availability, SQL execution, actual Auth callbacks, worker
runtime behavior, and live switch state remain unverified. No packages were
installed and no copied code, tests, workers, operational scripts, database
reconstruction, hosted Supabase operation, or deployment was executed. Existing
Web, Admin and mobile repositories are outside the write scope.

Stop after Stage 1B and return for CTO review. Do not begin toolchain setup,
additional test/script migration, CI migration, Web cleanup, or ownership transfer.
