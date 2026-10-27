# Ratings V1 launch-readiness handoff — 27 October 2026

Local verification is extended; launch acceptance remains blocked on native PG17,
real Auth and installed-environment evidence. No GitHub, hosted Supabase, migration,
deployment, flag or scheduled-job operation was performed. The user reports PR #59
merged and all six migrations deployed to Test and Production; not independently
verified here. Do not reapply them or use old candidate deployment scripts to do so.

## Exact task files

- `tests/ratings/run.mjs`: invokes added launch checks at suite end; replaces the
  native-only rollback check with a cross-engine, unrelated-job-preserving check.
- `tests/ratings/launch-readiness.mjs`: seven additional SQL scenario checks.
- `tests/ratings/auth-test-only.mjs`: opt-in real Auth/API disabled-state verifier.
- `tests/ratings/auth-test-only.test.mjs`: three offline verifier/guard tests.
- `tests/ratings/launch-monitoring.sql`: aggregate read-only operator queries.
- `tests/ratings/launch-readiness-plan.md`: plan written before implementation.
- `tests/ratings/launch-readiness-handoff.md`: this handoff.
- `tests/ratings/launch-readiness.diff`: exact task patch; excludes itself.

All paths relative to FairSwap-Backend. Existing Ratings files are untracked in this
checkout, alongside unrelated modified/untracked work. Task diff uses the observed
pre-task runner content, not HEAD (which has no Ratings runner). No unrelated files
were edited. Observed main HEAD: `213b57c84e2b3767e3ab3499846dd280bf3315c3`.
No fetch/pull; this is not a synchronized release base.

## Executed evidence

| Command | Actual result |
| --- | --- |
| `node tests/ratings/run.mjs` | PASS: 50 database scenario checks, PGlite 0.5.8 / PostgreSQL 18.3 WASM |
| `node --experimental-strip-types --test tests/ratings/contract.test.mjs` | PASS: 7 tests, zero failed/skipped |
| `node --test tests/ratings/auth-test-only.test.mjs` | PASS: 3 tests, fake transport only |
| `node scripts/verify-migration-manifest.mjs` | FAIL: malformed manifest line 1 in existing working checkout; preserved |
| `node tests/ratings/verify-baseline.mjs` with process-scoped Git safe.directory | PASS: 58 pinned historical Git blobs, EOL-aware working identities and unchanged manifest |
| `powershell -NoProfile -ExecutionPolicy Bypass -File tests/ratings/run-native.ps1` | BLOCKED: sandbox initdb restricted-token error 87; outside sandbox retry found installed `share/postgres.bki` missing |
| `node tests/ratings/auth-test-only.mjs` against Test | NOT RUN: no hosted access/token use authorized in this coding session |
| Hosted Test / Production acceptance, monitoring SQL | NOT RUN |

Initial new fixture run failed because display_name was absent; corrected the fixture
and reran successfully. No production SQL defect was inferred from that fixture error.
The manifest failure is not reported as a passing raw-byte integrity check.

## Coverage and its limits

Existing checks exercise confirmation, seller-only expiry, reciprocal double-blind
publication, sealed export/Received/public privacy, disputes and resolution, immutable
review/reply retries, malformed text/tags/faces, outsider access, staff role/AAL2/account
and flag checks, moderation evidence audit, hide/restore/exclusion/void recomputation,
three-review threshold and true zero score, privacy deletion, consumer DTOs and cursors.
Added checks cover missing identities/outsider AAL2, four-user direct DML denial,
14-day invariant and deadline rejection, all 64 generated SQL scores, 205 due trades
drained 200+5+0, 205 delayed reminder trades with 410 day10 receipts and no day3
receipts, repeat deduplication, and rollback preserving reviews and an unrelated job.

Fixture auth.uid/auth.jwt, account-policy provider and cron are emulated. AAL2 fixture
claims do not prove MFA enrollment/challenge or cryptographic JWT validation. Native
concurrent-session coverage in the existing runner was NOT RUN. Neither engine runs
the complete deployed migration ledger, hosted Auth, PostgREST or real pg_cron.
Direct table denial proves ACL/RLS boundary behavior collectively, not an isolated
RLS-policy path where ACL already denies. Fixture branches temporarily enable local
in-memory flags to exercise behavior; persistent/hosted flags stay OFF and the suite
finishes with all four local flags OFF and Ratings jobs inactive.

The Test-only runner validates five existing tokens through `/auth/v1/user`, four
distinct identities, same staff identity at two assurance levels, invalid-token denial,
25 direct-table read denials, disabled Ratings RPCs and staff guard ordering. It sends
only reads and read-only RPCs, refuses every URL except the exact Test project, never
creates users or logs token/response content. It cannot prove enabled-state hosted
flows while flags must stay OFF. Test tokens must represent active pre-existing users;
staff must have the actual moderator/administrator role and fresh AAL1/AAL2 sessions.

## Database and environment changes

No additive database migration is necessary for these checks. No migration bytes,
grants, RLS, RPC signatures, schema, package manifests, config or Actions were changed.
No new runtime variables in either Test or Production.

| Verification variable | FairSwapTest | FairSwapProd |
| --- | --- | --- |
| `RATINGS_AUTH_TARGET` | `FairSwapTest` | Not supported |
| `RATINGS_AUTH_URL` | Exact Test HTTPS project URL | Not supported; runner refuses Production |
| `RATINGS_AUTH_PUBLISHABLE_KEY` | Test publishable/legacy anon key | Not used |
| `RATINGS_AUTH_SELLER_TOKEN` | Active seller access token | Not used |
| `RATINGS_AUTH_BUYER_TOKEN` | Active buyer access token | Not used |
| `RATINGS_AUTH_OUTSIDER_TOKEN` | Unrelated active user access token | Not used |
| `RATINGS_AUTH_STAFF_AAL1_TOKEN` | Staff session before MFA assurance | Not used |
| `RATINGS_AUTH_STAFF_AAL2_TOKEN` | Same staff session identity at AAL2 | Not used |

Provide variables via the operator's secure process environment, never files/logs or
command arguments. No service-role key or database URL is required. Disposable suite
needs Node 24.15.0 and existing pinned dependencies; native runner additionally needs
a complete PostgreSQL 17 installation (`PgBin`/`PsqlBin` parameters, not env vars).
Production monitoring uses an already-authorized private operator session, no new
application credential. Monitoring owner and alert destination must be assigned.

## Staging-first delivery and production instructions

1. ChatGPT reconciles these local-only changes against the merged PR #59 source,
   confirms the six deployed migration hashes/ledgers and preserves unrelated work.
   ChatGPT owns branch/commit/PR/Actions. Preserve all existing CI gates; no workflow
   edits are included. Proposed extra commands are the three Node checks above and
   the existing disposable native PG17 harness on a complete supported installation.
2. On FairSwapTest (`wpppxlnbzqynvhpeuavd`), the authorized release operator runs
   automated read-only installed-state checks: all four flags false, Ratings schedules
   absent or inactive, deployed function/grant/RLS/privacy-wrapper definitions matching
   reviewed source. Do not execute provisioning, job functions or migrations hosted.
   Run the opt-in Auth command with existing secure Test tokens; retain sanitized
   pass/fail evidence. Any enabled-state end-to-end test requires a separate disposable
   environment/authorization, not a flag change in these two hosted projects.
3. After automated staging evidence, ChatGPT can deliver the verification-only source
   change through the normal repository gates. No database deploy step exists for
   this change. Production (`kriuhwppxgxsyyrbjsau`) receives only authorized read-only
   ledger/source/flag/job checks and monitoring setup; no synthetic test writes or
   Auth runner. Record environment identity, source SHA, execution time and results.
   No owner manual/exploratory test or predeployment owner testing gate is requested.
4. Ratings activation remains outside this task. Do not enable flags or scheduled
   jobs. Any discovered installed SQL defect needs separately reviewed additive
   forward SQL, explicit RLS implications, isolated Test/Production packaging and
   release authorization; never modify/reapply the six deployed files.

## Remaining launch blockers and production monitoring

- Reconcile actual merged source/deployed ledgers with this unsynchronized dirty
  checkout; resolve raw manifest verification failure without changing immutable SQL.
- Obtain passing native PG17 complete-chain/concurrency and real Auth evidence.
  Confirm actual MFA assurance transitions and installed staff membership in Test.
- Hosted enabled-state consumer integration, load qualification/global-lock contention,
  real scheduler execution and notification delivery remain unverified. Existing
  architecture allows repeat confirmed pairs on distinct listings; no cooldown,
  identity verification or automated collusion detector is added. Fraud tags are
  private signals, not proof. Record the fraud response owner and accepted V1 limits.
- Confirm production backup/restore evidence, privacy-wrapper chain and audit retention
  owner under the existing release gates. Local fixtures cannot certify them.
- Operator should run `launch-monitoring.sql` read-only after release and on an agreed
  cadence. While disabled, alert on any true flag or active Ratings job; a due backlog
  can be expected while disabled and must not itself trigger processing.
- For a future separately authorized activation: alert on any publication/reminder job
  failure, publication oldest-due age above two publication intervals (10 minutes),
  growing backlog across two cycles, impossible score/threshold rows (must be zero),
  unexpected audit gaps/tampering or private-table exposure. Monitor staff permission
  denials, report/dispute volume, cursor progress, deduplication constraint failures,
  notification insert errors, lock waits/deadlocks and RPC latency. Set traffic-based
  thresholds and dispute SLA with the operator; no invented production baseline.
  Use aggregate metrics/IDs only, never sealed bodies, report text, JWTs or PII.

One-line operational rollback (authorized operator only): execute existing
`releases/candidates/ratings-v1/rollback-disable.sql` in the verified target project;
it disables all four Ratings flags and only Ratings jobs, retaining data and APIs.
No rollback execution is required for this verification-only delivery. Source rollback:
ChatGPT reverts only this task patch through normal review; never revert deployed SQL.

Reference checked: https://supabase.com/docs/guides/database/postgres/row-level-security
(grants and policies are distinct boundaries). Changelog markdown retrieval was
unavailable through the browsing tool; no new Supabase API/library feature is used.
