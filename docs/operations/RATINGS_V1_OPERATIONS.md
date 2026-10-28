# Ratings V1 operations — release delta, 28 October 2026

Responsible operator: **Vivek Kumar, FairSwap release owner**. Route the existing
`OPERATIONS_ALERT_WEBHOOK_URL` sink to the operator's monitored incident channel.
No webhook URL, service key, private case text or participant identifier belongs in
logs or release receipts. This document is a release procedure, not hosted evidence.

## Dependencies and environment configuration

Apply only `20261028104504_ratings_operations_v1.sql`, after the six existing Ratings
migrations through `20261026094908_ratings_consumer_contract.sql`. Do not alter or
reapply any existing migration, run raw `db push`, or copy Test-only migrations to
Prod. The new migration is transactional, additive and backward compatible with
existing consumer RPCs. New private tables have RLS enabled and forced, deny all
client/service table access, and expose no client policies. Service-only diagnostic
RPCs use invoker wrappers over restricted private definers. Staff APIs and MFA checks
are unchanged. The existing notification table keeps its owner-read RLS.

| Server environment | FairSwapTest / staging | FairSwapProd / production |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` (existing) | `https://wpppxlnbzqynvhpeuavd.supabase.co` | `https://kriuhwppxgxsyyrbjsau.supabase.co` |
| `SUPABASE_SECRET_KEY` (existing; legacy `SUPABASE_SERVICE_ROLE_KEY` fallback) | Test-scoped server secret | Prod-scoped server secret |
| `RATINGS_OPERATIONS_ENVIRONMENT` (new) | `FairSwapTest` | `FairSwapProd` |
| `CRON_SECRET` (new if absent) | Separate random secret, at least 32 characters | Different random secret, at least 32 characters |
| `OPERATIONS_ALERT_WEBHOOK_URL` (existing) | HTTPS incident sink secret | HTTPS incident sink secret |
| `FAIRSWAP_RATINGS_V1_ENABLED` / `FAIRSWAP_RATINGS_PUBLIC_SCORE_ENABLED` | `false` / `false` | `false` / `false` |
| Backend `enabled`, `public_reads`, `jobs_enabled`, `staff_enabled` | All false | All false |

Keep any existing Admin Ratings flags false too; this task does not modify Admin.
No new Edge worker, Vault credential or public runtime secret is required.

## Automatic monitoring

Web's authenticated `GET /api/internal/ratings-monitor` is invoked every five minutes
by a trusted external scheduler. It is independent of Ratings activation. Authenticate with
`Authorization: Bearer <CRON_SECRET>`. The endpoint rejects missing/short secrets
and mismatched project/environment configuration before privileged access. It sends
only environment, fixed alert codes, responsible operator and runbook path.

Run `node tests/ratings/monitor-scheduler.mjs` from the scheduler in each environment
with `RATINGS_OPERATIONS_ENVIRONMENT` and `CRON_SECRET` injected securely. The runner
fixes Test to `https://fair-swap-git-staging-fairswap.vercel.app` and Prod to
`https://fairswap.in`, rejects redirects and validates the response. For protected
deployments inject the existing environment-specific `VERCEL_AUTOMATION_BYPASS_SECRET`;
never disable protection. Configure nonzero-exit/non-2xx alarms and an independent
ten-minute missing-success heartbeat alarm to Vivek Kumar. This detects database,
webhook and monitor outages when the primary monitor cannot report itself. No hosted
scheduler is provisioned by this source change.

Optional Pro/Enterprise primary scheduling: merge Web's
`docs/operations/ratings-monitor.vercel-cron.json` fragment into its deployment
configuration. Keep independent heartbeat supervision. Vercel cron runs only on
production deployments; the existing staging branch preview is not a scheduler.
Five-minute expressions fail deployment on Hobby, so the checked-in `vercel.json`
is preserved and the external runner is the plan-independent default.

The database checks both exact cron schedules/commands and activation state:
publication `*/5 * * * *`, reminders `17 * * * *`. While enabled, absence of a
successful run for **10 minutes / 75 minutes** alerts separately. Latest failed
runs and unfinished runs older than those thresholds also alert. `cron.log_run`
must be on and history retention must exceed 75 minutes. While disabled, jobs should
be inactive; missing jobs or changed schedule/command still alert. Cron provisioning
remains an owner-only, flags-OFF operation; it is never invoked by the HTTP monitor.

Other alerts: due unclosed trades older than ten minutes; invalid score/count/null/
dimension invariants; duplicate receipt/delivery identifiers (also prevented by
unique constraints); missing linked notification persistence; overdue initial action
notifications; and any unresolved dispute **or review report** older than 24 hours.
The 24-hour threshold is an operator escalation target, not a public service SLA.
Historical receipts have `delivery_version=0`: preserve them as idempotency evidence;
do not recreate notifications when old persistence cannot be unambiguously proven.
New deliveries have version 1 and a unique notification FK. Missing version-1
notifications alert rather than silently recreating potentially dismissed content.

Claims are serialized in PostgreSQL. A two-minute lease prevents overlapping polls;
successful webhook delivery is acknowledged using its unguessable lease token.
Failure is not acknowledged and is retried after lease expiry. Persistent conditions
repeat at most hourly; a cleared condition resets the incident. Transport is
at-least-once: a crash after webhook success and before acknowledgement can duplicate
an alert. Do not promise exactly-once external delivery. No raw cron return_message
or user evidence leaves the database. Retain alert rows (one per fixed code); prune
cron history under the existing operator policy without losing the freshness window.

## Processing and recovery

Publication preserves the 200-trade batch, transaction advisory lock, immutable event
keys and in-transaction recomputation. Failure rolls back the batch, so the next
scheduled run can replay safely. Reminders keep their serialized round-robin cursor
and distinct initial/day3/day10 receipt keys. Notification and receipt insertion are
atomic. Initial notification failure no longer undoes the sold/confirmation write;
the hourly reminder scan retries outstanding initial actions. Do not invoke global
workers to test or diagnose real users.

1. Acknowledge the incident in the operator channel. Verify project identity and
   read `tests/ratings/launch-monitoring.sql`; collect aggregate counts and relevant
   SQLSTATE securely. Do not copy job commands or errors containing secrets.
2. For missing/failed/stalled cron or drift, inspect cron availability, run logging,
   lock contention and matching job metadata. Cancel a stuck run only after confirming
   its exact session and transaction; rollback leaves receipt/cursor state retryable.
   Restore only the two reviewed job definitions. Activation remains a separately
   coordinated release decision; never auto-enable flags or jobs during repair.
3. For backlog or reminder delivery loss, fix the underlying SQL/notification error
   and let the next scheduled batch retry. A growing backlog requires capacity review
   of batch size and cadence; never loop global jobs as acceptance. Do not delete
   receipts or force duplicate notifications. Investigate version-1 FK loss privately.
4. For reputation violations, disable public Ratings reads in the coordinated incident
   response, investigate the authoritative reviews/trades and apply a reviewed forward
   fix/recompute. Do not edit scores or bypass dispute/risk/void eligibility by hand.
5. For duplicates, preserve receipts and notifications as evidence, stop Ratings jobs
   if needed, find the bypassing writer and repair forward. For aged moderation cases,
   assign the case to authorized nonconflicted staff and resolve through existing AAL2
   RPCs with an audit reason; no automatic moderation resolution is implemented.
6. A successful subsequent monitor poll clears resolved conditions. Failed webhook or
   ack yields HTTP 503; the independent scheduler must alert, and leases allow retry.

## Isolated automated hosted processing acceptance

NOT RUN here. Global `publish_due_reviews` / `rating_reminders` remain unavailable to
service credentials. `ratings_process_fixture(trade_id)` is service-only, Test-only
and validates Vault's unique `project_url` against FairSwapTest on every invocation.
The owner must separately authorize and provision two synthetic nonstaff accounts
whose Auth emails end in `@ratings-test.invalid`, one dedicated trade with no listing
or conversation, and its `rating_acceptance_fixtures` row expiring within one hour.
Neither account may participate in any other trade. Enrollment has no service/API
grant. Use a restricted secure session; do not write credential values to files.

Only the explicitly allowlisted trade is processed, even while all global flags are
OFF. Notifications persist in-app only to those synthetic identities; no email or
global dispatch is added. Fixture processing cannot create trades, enroll users,
grant staff roles, change flags, move deadlines, or operate on Prod. Owner cleanup
removes fixture receipts/notifications, events/reviews, registry row, trade and
synthetic Auth identities in FK-safe order under the original fixture authorization;
never delete by a broad email pattern or touch unrelated accounts.

Secure process inputs: `RATINGS_ACCEPTANCE_TARGET=FairSwapTest`,
`RATINGS_ACCEPTANCE_URL=https://wpppxlnbzqynvhpeuavd.supabase.co`,
`RATINGS_ACCEPTANCE_TRADE_ID` (owner registered), `RATINGS_ACCEPTANCE_SERVICE_KEY`
(Test server secret). `node tests/ratings/hosted-processing.mjs` invokes only that
scoped RPC twice and checks replay. Modern secret keys use only `apikey`; legacy
service-role JWTs also use bearer auth. Secrets are never accepted as public inputs.
Never run it without separately authorized fixtures. This verifies processing replay,
not real Auth/MFA; the SQL suite verifies persistence, privacy gates and isolation.

## Deployment sequence and rollback

ChatGPT/release operator owns GitHub and deployment. First reconcile the dirty local
bases against the actual integrated source/ledgers; do not publish unrelated changes.
Verify backups, existing six Ratings migration hashes, installed privacy exporter
chain/ACLs, and environment-specific migration histories in isolated workspaces.

1. Apply this additive migration to FairSwapTest using the existing reviewed release
   mechanism. Keep all flags OFF. Provision the existing two jobs inactive only if
   needed. Deploy Web source/config to the Test environment and configure its external
   scheduler. Execute authorized automated acceptance; no owner staging test gate.
2. Once automated release checks pass, repeat the reviewed isolated migration and Web
   configuration for FairSwapProd; deploy the compatible Admin candidate through its
   existing release process. Do not assume this task verified the Admin repository.
3. Deploy HelpCenter corrections; all four drafts remain withheld from production by
   `src/lib/content.ts` until the existing all-locale human editorial gate is satisfied.
4. Verify scheduler receipts, flags-OFF state, inactive Ratings job metadata and monitor
   health automatically in each environment. Record exact deployment IDs, migration
   versions and evidence. Coordinated activation is outside this source task.

Rollback: turn all four private gates and all Web/Admin Ratings flags OFF, deactivate
only `ratings-v1-publication` and `ratings-v1-reminders` using the existing rollback
script, then revert Web/HelpCenter task source through ChatGPT's release process.
Keep monitoring available to observe recovery. Preserve migrations, receipts, review
history, cases and alert state; no down migration or table deletion. New definitions
remain compatible with old clients. For a SQL defect, ship a reviewed forward fix.

After deployment the owner checks **production** Auth, buyer/seller ownership, AAL1
staff denial, actual MFA elevation for authorized nonconflicted staff, privacy of
sealed evidence and inactive/unauthorized denial. With all flags OFF, enabled-state
flows remain unavailable; inspect those only after a separately coordinated activation.
Check monitoring delivery and flag state from production operator evidence, and confirm
draft articles remain unpublished. No agent/manual/exploratory testing or staging
owner testing is requested or claimed.

References: [Cron history](https://supabase.com/docs/guides/cron),
[function security](https://supabase.com/docs/guides/database/functions),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[Vercel cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs),
[API key headers](https://supabase.com/docs/guides/getting-started/api-keys).
