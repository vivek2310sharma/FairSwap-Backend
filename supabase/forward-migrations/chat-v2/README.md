# Chat V2 protected external scheduler

## Protected external scheduler — current release design

26 October 2026. Requested integration base:
`1c36b276c80520701922b212aca5bfef578ce932` (PR #58). This section supersedes the
older pg_net release instructions below. No hosted change, deployment, GitHub
mutation or feature activation was performed. All five Chat V2 flags stay OFF.

### Infrastructure review and provider choice

FairSwap already operates Backend GitHub Actions, Supabase Edge Functions/Vault,
and Vercel-hosted applications. Source configs and read-only connector metadata
confirm the FairSwap Vercel team; its plan was not available from that metadata.
No new provider account, application server or Web-repository change is needed
for the selected **GitHub Actions** scheduler.

- Actions supports five-minute schedules on the default branch. It can delay or
  drop scheduled runs under load; it is not an exact-time or low-latency guarantee.
  Production is prepared for five-minute ticks, Test hourly, at non-hour-boundary
  UTC offsets. The operational workflow is completely separate from Backend CI.
- Vercel was considered because FairSwap uses it. Hobby supports daily cron;
  frequent cron needs Pro/Enterprise and a function proxy. The existing plan is
  unverified, and a proxy would add another credential-bearing runtime.
- Cloudflare Workers Cron was considered as a low-cost option, but no existing
  FairSwap Workers account/ownership was established. It was not chosen over an
  already-operated service. No Cloudflare resources are provisioned.

Sources: [Actions scheduling](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing),
[Vercel cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The scheduler uses `ubuntu-slim`, published at USD 0.002/billable minute as reviewed
on this date. At 30 days, 8,640 Prod plus 720 Test jobs yield about USD 18.72 gross
at one billable minute/job, or USD 37.44 if jobs consume two minutes. These are
estimates before shared plan allowances, taxes, setup/cancellation overhead or
price changes, **not a spend cap**. The workflow has a two-minute timeout and does
no dependency install/build per tick. Owner budget/minute availability and warning
latency/backlog acceptance must be reviewed before enabling schedules. If a
five-minute-and-provider-delay warning is insufficient, use a separately reviewed
dedicated scheduler; do not claim instant warning delivery from Actions.

### Security, idempotency and observation

`.github/workflows/chat-safety-scheduler.yml` defines separate jobs/environments
`chat-safety-test` and `chat-safety-prod`. Both require the exact repository,
`refs/heads/main`, an appropriate schedule/explicit operational target, and an
explicit repository enable variable equal to `true`. Missing variables keep the
jobs skipped without allocating a credential-bearing runner. Each environment
has its own secret with the name `CHAT_SAFETY_WORKER_SECRET`; values must be
different. Secrets enter only the dispatch step, after SHA-pinned checkout and
Node setup. No PR trigger, inherited secrets, dependency lifecycle or deploy step.
Required owner setup includes main-only environment deployment policy and reviewed
main-branch code controls. Actual account feature availability remains to verify.

The runner sends only a dedicated opaque credential in standard `Authorization`,
never a Supabase API/service-role key, cookie or JWT. This token authenticates only
the existing `process-chat-safety` endpoint, not arbitrary Supabase RPCs. The client
uses two exact hardcoded HTTPS URLs, denies redirects, sends no credential in
URL/body, reads at most 2 KiB, validates counts, and discards raw errors/bodies.
Logs contain only fixed event/status/category and bounded counts/attempts.
Service credentials accidentally injected into the runner cause a closed failure.
Do not log headers, request objects, env dumps or enable HTTP debug logging.

Three deliveries maximum, 15-second request timeouts, 1/3-second waits; no infinite
loop, background retry or provider redirect. `gha:<run_id>:<target>` is stable
across delivery retries and GitHub reruns (run_attempt is intentionally excluded).
Per-target workflow concurrency has cancel-in-progress false; a DB lease is the
authoritative overlap guard even if GitHub delays, duplicates or interrupts a run.
Rejected auth/config is terminal. Busy/transient failures retry within the same
finite bound. No real scheduler/worker request was made during local verification.

The Edge Function preserves its dedicated authentication, including legacy custom
header compatibility, and rejects conflicting headers or malformed invocation/
target before client creation. It hashes the raw token with SHA-256 and calls
`verify_chat_safety_worker_digest(candidate_sha256)` as the sole DB authentication
operation. The raw credential is **never a SQL/RPC argument**. The proof is not a
usable HTTP credential: sending it as the token is hashed again and rejected.
The old raw verifier loses service-role EXECUTE during the additive cutover;
deploy the compatible Edge version before enabling anything. Existing
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` Edge runtime contract stays unchanged.

The new private forced-RLS run table has no client/service direct grants. Service-
only begin/finish RPCs bind target to the configured project, serialize via the
runtime row and a one-processing-run index, issue opaque lease tokens and reject
stale completion. Completed deliveries replay cached counts without another batch.
Leases last 120 seconds; at most three expired-lease attempts per invocation.
Failed attempts remain visible, and message-level five-attempt backoff, stable
message IDs and recipient-only findings remain authoritative. Run metadata expires
after 90 days via at most 100 terminal-row deletions per enabled tick; this defines
the run-cache idempotency window, not message/evidence retention.

`chat_safety_scheduler_metrics()` exposes only aggregate run outcomes and latest
start/finish times to service_role. Combine it with existing queue/exhaustion/
recovery metrics. GitHub job failure notifications and non-advancing heartbeat /
growing backlog are owner monitoring signals. Disabled ticks report disabled and
zero work; they are not claims of successful classification. Account notification
preferences, billing limits and alert ownership require release configuration.
No Slack/email message sender or new notification destination was added.

### Additive cutover and inactive environment artifacts

New CLI-issued migration:
`supabase/migrations/20261026093748_chat_safety_external_scheduler.sql` in this
isolated forward directory. Earlier migrations and the historical 58/checksum
manifest remain unchanged. Apply only reviewed isolated artifacts after exact
environment ledger reconciliation; never push the historical directory raw.

The migration adds scheduler metadata/digest RPCs, keeps external dispatch disabled,
disables only the two old **Chat Safety** cron jobs if present, and replaces the
Chat DB dispatcher with a credential-free retired stub. It does not call pg_net,
alter its grants/owner, modify managed triggers, touch email/moderation dispatch,
or delete old queue/evidence/Vault data. `configure_chat_safety_inactive` becomes a
safe compatibility alias for external setup. Old project_url provisioning is
explicitly retired. Historical queue-boundary tests remain in CI; they do not
authorize an extension-owner grant change or serve as the new release path.

Use only `release/external/` for this release. The two JSON manifests declare
enabled false, target/project/environment mapping, UTC cadence and retry limits.
The two inactive SQL files call `configure_chat_safety_external_inactive`. It
requires five flags off, both dispatch controls inactive, correct independent
existing private email/moderation URL anchors, and a non-conflicting project binding.
It preserves an existing valid dedicated Vault token or generates one encrypted
in Vault; no token is returned. Repeating inactive setup is idempotent. Unlike the
obsolete path, it needs neither queue ACL changes nor a Vault `project_url` entry.
Any present conflicting shared URL remains a fail-closed signal, never overwritten.

**Names only — never put values in this repo, SQL literals, chat, CLI arguments or logs:**

| Scope | Names |
| --- | --- |
| Existing Edge runtime | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Dedicated Vault credential | `chat_safety_worker_secret` |
| Existing independent Vault identity anchors | `email_outbox_worker_url`, `moderation_worker_url` |
| GitHub environments | `chat-safety-test`, `chat-safety-prod` |
| Environment secret (distinct value per environment) | `CHAT_SAFETY_WORKER_SECRET` |
| Repository enable variables, absent/false initially | `CHAT_SAFETY_TEST_SCHEDULER_ENABLED`, `CHAT_SAFETY_PROD_SCHEDULER_ENABLED` |
| Runtime script inputs (not user-supplied endpoints) | `CHAT_SAFETY_TARGET`, `CHAT_SAFETY_SCHEDULER_ENABLED`, `GITHUB_RUN_ID` |

An authorized owner must bridge the dedicated token from Vault to the matching
protected GitHub secret through a provider-approved secret-management channel.
This handoff does not export/decrypt/copy a live token or invent a secret broker.
Do not retrieve secrets through transcript-producing tools or print SQL results.
If any old Chat credential may have traversed a public-grant queue, rotate that
dedicated credential securely before adoption; never reuse an exposed token.

### Test-first release and rollback (ChatGPT owned)

1. Reconcile this delta onto the requested PR base, review protected source/secret
   policy and cost/latency, run all existing/new CI gates, and obtain environment-
   scoped release authority. Integration/merge is not deployment or flag authority.
2. On **FairSwapTest first**, apply the three reviewed additive Chat migrations in
   order with all five flags off, deploy the compatible authenticated Edge version,
   then apply the external Test inactive config. Any earlier candidate already
   applied requires proper ledger reconciliation; do not rewrite it.
3. Provision the distinct Test GitHub secret and environment policy securely; keep
   its enable variable false. Main-branch workflow delivery requires main integration
   (Actions schedules do not execute a PR branch). Authorized automated integration
   evidence may enable only the external transport controls while feature flags
   remain off: the worker must authenticate and report disabled with zero work.
   This task performs none of those hosted actions and adds no manual test gate.
4. After automated Test evidence, repeat independently for **FairSwapProd** with
   the Prod manifest/secret. Keep its variable and DB external control off until
   separately authorized. This release does not enable warnings or any rich feature.
5. Future warning activation still requires compatible recipients/policy readiness
   and explicit authority. Monitor default-branch scheduled delivery, outcomes and
   queue depth/exhaustion. GitHub delay/drop and budget suspension are real limits.

Rollback: turn both repository enable variables false and the relevant DB external
control off; keep warning/other feature flags off. Revert the Edge/runner release
to a compatible safe digest-auth version if needed; retain additive data/evidence.
Rotate the dedicated token if compromised. Never restore the Chat pg_net cron,
raw-token SQL verifier, shared queue ACL changes, or an exposed-token transport.
In-flight DB leases may finish metadata safely; disabling the warning flag hides
findings immediately under existing RLS. Email/moderation workers remain untouched.

### Automated evidence and remaining prerequisites

New tests cover fixed destinations/redirect denial, strict input/response bounds,
secret-safe errors, three-attempt retries and stable IDs, protected/default-off
workflow/manifests, hash-only auth, cached completions and overlap/target rejection,
lease exhaustion/stale tokens, service-only metadata and five flags off. The same
external SQL fixture runs after the existing privilege fixture in PGlite and the
required native PG15 CI step; old gates are retained. Actual local results are in
the handoff, not assertions of hosted/Deno/GitHub execution.

Remaining release prerequisites: exact ledgers/authority, secure per-environment
secret provisioning, main-only environment/branch controls and plan availability,
budget/latency/backlog acceptance, fresh GitHub/native-PG15/Deno/hosted automated
evidence and later recipient/policy readiness. The unsupported pg_net ACL route
is no longer a transport prerequisite. Local Windows cannot execute the required
native Linux Docker runner; its execution awaits ChatGPT CI. No hidden provider
account, deployed resource or successful hosted delivery is claimed.
