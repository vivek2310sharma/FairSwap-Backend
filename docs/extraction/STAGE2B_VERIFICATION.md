# Stage 2B final verification record: accepted with documented exceptions

Finalized: 16 October 2026 (Europe/Copenhagen). Stage 2B technical verification
is accepted with the exceptions below, following the accepted R3–R6 reports.
This is local verification of the extraction baseline, not production readiness
or deployment authorization. R7 updates this record from existing sanitized
evidence only; Docker, Supabase, SQL and tests were not rerun.

## Baseline and scope

- Repository: vivek2310sharma/FairSwap-Backend.
- Branch: chore/backend-extraction-baseline.
- HEAD: 570c573cecaa65545ccc9e9e57fd879032861c30
  (test(backend): establish independent unit verification).
- Immutable extraction checkpoint: 47eabc28253951b733f607c61ed08bfa45e60248.
- Approved Web source: 9e65bfc42eab9697a0a144ed8546afe8309eaea3.
- Pinned Supabase CLI: 2.117.0; PostgreSQL: 15.8 (server_version_num 150008).
- MIGRATION_MANIFEST.sha256 digest:
  eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd.

The prior Stage 2A record reported successful typechecking and 93 unit assertions
across five files. Those historical checks were not rerun for R7. Canonical SQL,
tests, manifests and application code remain unchanged. Deployment ownership
remains as recorded in docs/operations/DEPLOYMENT_OWNERSHIP.md.

## Acceptance matrix

| Stage | Accepted local check | Recorded result | Boundary / exception |
| --- | --- | --- | --- |
| R3 | Fresh PG15 startup and host SQL connectivity | PASS; PostgreSQL 15.8; actual database mapping 127.0.0.1:55612 and [::1]:55612 to 5432/tcp | Loopback publishing verified; complete outbound isolation not proved |
| R4 | Immutable migration reconstruction | PASS; 58/58 applied; every ledger version matched canonical filenames; all original migration hashes and manifest digest verified | No SQL corrections, added seed files or hosted target |
| R5 | Nine required pgTAP suites | PASS; 9/9, 270 assertions, zero failures; each CLI exit 0 | Email-outbox diagnostic excluded from required suite total |
| R6 | Read-only security and runtime catalog checks | Completed: listing/email RLS, private buckets, worker RPC ACLs, extensions and both retry cron jobs inspected | Broad trigger EXECUTE grants remain an open authorization review |
| R5–R6 | Post-test safety state | PASS; exact 58-version ledger unchanged, Vault count 0, moderation_automation_enabled = false | No hosted end-to-end authorization validation |
| R6 | Standalone excluded email diagnostic | FAIL; CLI exit 1, psql exit 3; 31 assertions executed, zero failed assertions | Undefined helper at line 59 and independent plan-count defect; historical CI exclusion retained |
| R6 | Cleanup and preservation | PASS; task resources removed, task port closed, Docker inventories matched preflight; Git files preserved | Default bridge ID changed in some earlier runs; cause unverified |

## Local procedure and historical startup failures

Each successful run used a new disposable project outside FairSwap repositories,
a unique ordinary Docker bridge and unused ports. Docker Desktop's
Localhost-by-default port behavior was changed by the operator before R3.
R3 first verified implicit publishing on a separate probe container:
127.0.0.1:55609 and [::1]:55609 mapped to 5432/tcp. R4, R5 and R6 database
ports were respectively 55712, 55812 and 55912, each observed on both loopbacks
only. Supabase was started without FairSwap migrations before copying SQL.

The runners used an explicit OS environment whitelist, isolated temporary
HOME/USERPROFILE/APPDATA directories and empty Docker configuration. No hosted
project link, hosted credentials, provider settings or worker endpoints were
supplied. Temporary [db.vault] configuration was empty. No custom relay or global
Docker changes were made by these runs. Only local CLI operations were used:
db start, migration up --local, db query --local and explicit-file test db --local,
with the task workdir and network ID. Relevant pinned CLI help was inspected.
R4–R6 used Supabase base schema initialization, without running Edge Functions
or email servers. No additional seed data was supplied beyond canonical SQL.

The initial Stage 2B internal-network attempt failed before migrations with
ECONNREFUSED 127.0.0.1:55462. R2 stopped on actual wildcard publishing at
0.0.0.0:55512 and [::]:55512 despite a bridge loopback-binding option. These are
historical failed attempts, superseded for local startup by R3; neither failure
is a successful isolation test. R3 also recorded an initial CLI version-check
telemetry-write EPERM; the isolated-environment version check then succeeded.

Loopback-only host publication does not establish complete outbound network
isolation. The successful ordinary bridges were not evidence of egress denial.
No hosted end-to-end authorization, provider delivery or worker dispatch was
validated. These limitations remain explicit deployment prerequisites below.

## Nine required pgTAP suites (R5)

Each immutable file was run once by explicit path with test db --local on the
disposable network. Each returned exit 0, with no missing tests, failed assertions
or unexpected SQL errors. The excluded diagnostic was not run in R5.

| Canonical file under supabase/tests/ | Assertions | Failed | Exit |
| --- | ---: | ---: | ---: |
| admin_medium_operation.test.sql | 6 | 0 | 0 |
| admin_reviewed_contract.test.sql | 10 | 0 | 0 |
| listings_insert_category_eligibility.test.sql | 28 | 0 | 0 |
| moderation_vault_dispatch_auth.test.sql | 11 | 0 | 0 |
| pending_review_media_invalidation.test.sql | 31 | 0 | 0 |
| schema_listings.test.sql | 28 | 0 | 0 |
| schema_post_ad_category_metadata.test.sql | 59 | 0 | 0 |
| schema_security.test.sql | 22 | 0 | 0 |
| seller_listing_category_context.test.sql | 75 | 0 | 0 |
| **Total: 9 suites** | **270** | **0** | **All 0** |

Official runner: public.ecr.aws/supabase/pg_prove:3.36, recorded digest
sha256:eda7c5e68719e9c8287e78c017118407b48df904a51c935f5ab6098b8c0bc6bc.
Per-file logs and task-network connection events are retained in R5 evidence.

## Read-only security checks (R6)

- RLS enabled on public.listings, public.listing_media and public.email_outbox;
  policy definitions inspected. Email-outbox table DML denied to anon and
  authenticated. Catalog inspection does not replace hosted authorization tests.
- Both listing-originals and listing-derivatives buckets had public = false.
- Email claim/complete/fail wrappers and implementations, moderation worker
  claim/finalization, legacy moderation and worker-secret verification RPCs denied
  anon/authenticated EXECUTE and allowed service_role. Reviewed staff/seller
  operations retained their distinct authenticated permissions; no blanket
  service-only claim is made for every inspected RPC.
- Required extensions present: pg_net 0.14.0, pg_cron 1.6 and supabase_vault 0.3.1.
- Vault contained zero secrets; moderation_automation_enabled remained false.
  Observed HTTP request queue and response counts were both zero.
- Two active jobs targeted the local postgres database as postgres:

| Job | Schedule | Command |
| --- | --- | --- |
| process-email-outbox-retries | */5 * * * * | SELECT app_security.invoke_email_outbox_retry_batch(); |
| process-moderation-queue-retries | */2 * * * * | SELECT app_security.invoke_moderation_retry_batch(); |

Cron configuration had database_name = postgres, host = localhost and
launch_active_jobs = on. Commands contained no external URLs or credentials.
Dispatch functions were not manually executed; worker/email dispatch was not
performed. Registration and configuration inspection do not prove delivery.

## Known test defects: excluded standalone email diagnostic

schema_email_outbox.test.sql remains historically excluded from CI and excluded
from the nine required suites. R6 ran the unchanged file once, separately:

- **FAIL:** CLI exit 1; psql exit 3; 34 planned, 31 executed, zero assertion
  failures. The runner reported a bad plan and nonzero exit, so zero failed
  assertions does not mean this diagnostic passed.
- First meaningful error at line 59:
  function has_constraint(unknown, unknown, unknown, unknown) does not exist.
  SQLSTATE was not emitted; 42883 (undefined_function) is an inference from the
  error, not a captured SQLSTATE.
- Four is_definer and four isnt_definer checks ran successfully before the error.
  Their installed pgTAP definitions were inspected read-only. They do not explain
  this failure. The final has_constraint call is unsupported in this environment;
  the named unique constraint itself was confirmed present in pg_constraint.
- Independent authored-plan defect: 34 planned versus 32 assertion calls. The
  last authored call errors, leaving 31 emitted assertions. Even completing all
  32 authored calls would leave a two-assertion plan mismatch.

No SQL/test correction, retry or CI inclusion change was made. Any diagnostic
repair or change to its exclusion requires separate review and authorization.

## Open security review items

public.handle_listing_moderation_enqueue() and
app_security.trg_fn_notify_moderation_worker() retained broad EXECUTE grants to
anon/authenticated. Both return trigger; their catalog grants alone do not prove
that an ordinary RPC caller can invoke a trigger function. These grants require
explicit authorization review and disposition **before cutover**. No ACL changes
or source patches were authorized or made during extraction verification.

## Deployment prerequisites and non-acceptance boundaries

Before cutover, separately authorize and complete the trigger-grant review and
hosted end-to-end authorization validation, and establish the deployment's
outbound-network controls. Localhost publishing is not complete outbound
isolation. Review the excluded diagnostic defects while preserving its historical
CI exclusion until a separately approved change.

This record does not authorize Stage 2C, deployment ownership transfer, worker
activation, credential provisioning, hosted SQL, production/test migrations,
email/provider sends or PostgreSQL 17 testing. No production-readiness claim is
made. Subsequent implementation and hosted acceptance require separate approval.

## Cleanup, preservation and retained evidence

Task-scoped stop --project-id ... --no-backup and removal of verified empty,
task-owned networks removed the labs. Existing containers, volumes and named
networks were preserved. Docker's default bridge ID changed during some runs
(including R4/R5); the cause remains unverified. R6 cleanup inventories matched
preflight exactly, and its task port was closed. These are recorded cleanup
results, not a new R7 live-state inspection.

Sanitized evidence is now retained in the repository under
[docs/extraction/evidence/stage2b/](evidence/stage2b/). R8 copied existing evidence
only; no Docker, SQL, Supabase, CI or tests were run. Verification conclusions,
known defects, open security items and deployment prerequisites above are unchanged.

| Stage | Retained result | Retained runner output |
| --- | --- | --- |
| R3 | [result.json](evidence/stage2b/r3/result.json) | Startup/connectivity results in JSON; supplementary temporary logs not included in this checkpoint |
| R4 | [result.json](evidence/stage2b/r4/result.json) | Original verified-result.json retained under normalized result.json filename |
| R5 | [result.json](evidence/stage2b/r5/result.json) | Nine per-file logs listed below |
| R6 | [result.json](evidence/stage2b/r6/result.json) | [Standalone email diagnostic](evidence/stage2b/r6/email-diagnostic.tap.txt) |

Runner logs use .tap.txt so repository ignore rules do not omit them. Original
filenames remain in provenance. The nine R5 logs are the available pg_prove TAP summaries; full individual
assertion lines were not present and have not been synthesized:

- [admin_medium_operation.tap.txt](evidence/stage2b/r5/admin_medium_operation.tap.txt)
- [admin_reviewed_contract.tap.txt](evidence/stage2b/r5/admin_reviewed_contract.tap.txt)
- [listings_insert_category_eligibility.tap.txt](evidence/stage2b/r5/listings_insert_category_eligibility.tap.txt)
- [moderation_vault_dispatch_auth.tap.txt](evidence/stage2b/r5/moderation_vault_dispatch_auth.tap.txt)
- [pending_review_media_invalidation.tap.txt](evidence/stage2b/r5/pending_review_media_invalidation.tap.txt)
- [schema_listings.tap.txt](evidence/stage2b/r5/schema_listings.tap.txt)
- [schema_post_ad_category_metadata.tap.txt](evidence/stage2b/r5/schema_post_ad_category_metadata.tap.txt)
- [schema_security.tap.txt](evidence/stage2b/r5/schema_security.tap.txt)
- [seller_listing_category_context.tap.txt](evidence/stage2b/r5/seller_listing_category_context.tap.txt)

[PROVENANCE.json](evidence/stage2b/PROVENANCE.json) records every source's
privacy-safe temporary location, original SHA-256, retained SHA-256 and redaction
count. [SHA256SUMS](evidence/stage2b/SHA256SUMS) covers the 14 retained evidence
files and provenance record. All requested evidence was available. Supplementary
logs and inventory files remain in the original temporary directories, identified
by stage in provenance; they are not part of this selected durable package.

All four result JSON files are byte-for-byte copies. The ten runner logs contain
12 path-only redactions (one per R5 log and three in the R6 diagnostic), replacing
identifying absolute project paths with <DISPOSABLE_PROJECT>. No credential or
token values were found in the inspected candidates. Existing diagnostic errors,
counts, exit statuses and public documentation URLs remain unchanged. No raw
environment files or other unreviewed temporary artifacts were copied.

R7 finalized the verification conclusions. R8 changes only this report's retained
evidence references and adds the selected evidence package. The existing
modifications to AGENTS.md, README.md, docs/extraction/POINT1_BASELINE.md and
docs/operations/DEPLOYMENT_OWNERSHIP.md are preserved byte-for-byte, including
historical text not reconciled in this file-scoped task. The report and evidence
remain untracked; the other four documents remain modified, unstaged and
uncommitted. Branch and HEAD are unchanged. No commits, pushes, PRs, hosted
operations, technical reruns or Stage 2C implementation occurred in R8. This
package is prepared for a separate approved local commit; no commit is authorized
or performed by this evidence-preservation task.
