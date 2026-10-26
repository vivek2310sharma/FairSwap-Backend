# Chat V2 — Phase 1B local infrastructure candidate

## Security correction — release remains blocked

26 October 2026; [blocker comment 6411236044](https://github.com/vivek2310sharma/FairSwap-Backend/pull/58#issuecomment-6411236044).
That comment reports Phase 1B integration at `2ceab16e447a0f94c130ef347a64fe7036e8c262`
and green GitHub CI, but identifies the missing Vault URL and unsafe shared queue
ACL change. Those are comment-reported facts; this correction did not inspect or
change either hosted database. Local HEAD remains the older observed `213b57c`.

The previous global queue `REVOKE` was unsafe. `net.http_post` is an invoker,
the queue/sequence belong to `supabase_admin`, and hosted `postgres` may have only
inherited PUBLIC rights. **The application migration now makes no extension ACL,
ownership or event-trigger change.** This preserves email/moderation/webhook and
worker access rather than attempting a non-owner revoke or an unsupported repair.
[Supabase's current guidance](https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect)
says individual-project pg_net grant changes are unsupported. No operator role
membership/escalation, managed-trigger replacement or destructive extension
recreation is proposed as a workaround.

`assert_chat_safety_net_privileges()` is a read-only fail-closed boundary. It
requires the expected extension owner and invoker signature, producer INSERT,
return-column/background-worker SELECT, worker DELETE, sequence USAGE and schema/
function access for `postgres`. It checks effective client, login-role, and direct
queue ACL access; unknown exposed configurations are denied. Trusted superusers
are inherently outside the credential isolation boundary. Existing Database
Webhooks require INSERT, sequence access and SELECT(id), without SELECT(headers).
An unknown pg_net worker role blocks release. The application functions must be
created as `postgres`; the migration rejects another application owner.

Release configuration, Vault prerequisite provisioning and every enabled Chat
dispatch call run this boundary check. It executes **before** reading a dispatch
token or enqueueing a request. An exposed queue or ACL drift blocks Chat Safety;
`dispatch_failures`, `last_dispatch_status`, and a fixed generic warning make the
failure observable without logging tokens, URLs, message bodies or SQLERRM.
Other runtime errors record `failed`; successful enqueue records `queued`.
Service-only `chat_safety_metrics()` returns those aggregate dispatch signals.

**Unresolved blocker:** there is no verified provider-supported protected enqueue
path or owner-authorized grant mechanism for these projects. Default exposed
queue grants cannot satisfy this check. Do not merge/promote for release, apply
the candidate migrations, provision Vault entries or create schedules until
ChatGPT has a supported solution and protected release authority. The code does
not claim the existing shared queue became private. It prevents new Chat Safety
credentials from entering it and leaves other dispatchers unchanged. If Supabase
cannot provide a supported route, choose a separately reviewed transport that
does not put a reusable credential in the public-grant queue; do not weaken the
guard. No new service-role key contract is introduced: `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` remain unchanged, with all five flags off.

### Vault prerequisite and preflight artifacts

- `release/pg-net.preflight.sql` is read-only metadata plus the boundary assertion.
  It prints owners/privilege booleans and the managed pg_net event-trigger function
  fingerprint, not headers, Vault values or function bodies. ChatGPT must review
  `issue_pg_net_access` / `extensions.grant_pg_net_access`, worker identity,
  actual producer ownership, and effective grants with the provider. Extension
  upgrades or managed trigger events can restore grants; do not alter those
  triggers locally. The per-dispatch boundary also fails closed after grant drift.
- `release/fairswaptest.vault-prerequisite.sql` and the separate Prod equivalent
  call owner-only `provision_chat_safety_project_url`. They create a missing
  `project_url` only after transport and inactivity preflight passes. The value is
  derived from a fixed environment allowlist; no credential literal or Vault
  secret value is present in source or returned by provisioning.
- Independent existing private Vault anchors (`email_outbox_worker_url` and/or
  `moderation_worker_url`) must exactly match the selected environment and known
  function path. Every present anchor must agree; at least one must already
  exist. Missing, duplicate, cross-environment or unexpected anchors fail closed.
  Do not manufacture/overwrite an anchor merely to pass this check. This is an
  owner-controlled Vault identity check, not trust in a caller-set GUC or JWT.
- Matching existing `project_url` is preserved, including its ID. A conflicting
  or duplicate entry is rejected, never silently overwritten. Both inactive
  setup files explicitly run the preflight before schedule/worker-secret setup.
  Five flags, runtime dispatch and existing Chat cron jobs must all remain off.
- Provisioning is prepared, not executed. The currently missing entries remain a
  hosted prerequisite; transport ownership blocks these scripts too. Only after
  that blocker is resolved and release authorization is obtained: verify exact
  Test ledger/target and preflight, provision Test URL, run Test inactive setup
  and automated acceptance, then repeat the independent Prod steps. Never push
  the raw historical migration chain or ask for manual predeployment testing.

### Automated privilege evidence and CI

`tests/chat-v2/bootstrap.sql` now models the actual ACL boundary: non-superuser
`postgres`, separate `supabase_admin` queue/sequence/function ownership, invoker
HTTP function using INSERT/RETURNING and a sequence, plus inherited PUBLIC ACLs.
The PGlite initial bootstrap superuser is renamed **only inside the disposable
fixture** so its implicit privileges cannot conceal the bug.

`net-privileges.test.sql` runs 19 counted assertions plus negative exception
checks. It proves a non-owner revoke is ineffective, unsafe setup is denied,
missing INSERT/SELECT/sequence privileges prevent enqueue, and drift blocks new
Chat dispatch observably. The actual immutable historical bodies of both email
and moderation immediate/retry functions are extracted and exercised before and
after a **hypothetical fixture-only owner repair**; no replacement dispatcher is
substituted. This demonstrates required semantics, not hosted repair authority.
Fixture-only GRANT/REVOKE/SET ROLE statements must never be applied to a project.

The same SQL fixture is emitted by `scripts/ci/emit-chat-net-privileges-sql.mjs`
and run by `run-chat-net-privileges-pg15.sh` as an additional required step of the
existing Chat V2 CI job. It reuses the exact existing PostgreSQL image digest,
asserts PG 15.8 (`150008`), uses a fresh unprivileged OS-user container, no host
ports, `--network none`, Unix sockets only, no credentials or hosted connection
parameters, and cleanup of only that container. This is a real PostgreSQL ACL
regression with fake net/Vault/cron surfaces, not real pg_net HTTP delivery.
Native Linux PG15 execution is **NOT RUN on Windows**; GitHub CI must execute it
after ChatGPT integration. PGlite executes the same privilege fixture locally.

The PGlite harness also covers idempotent Test/Prod provisioning and rejection of
missing, duplicate and mismatched anchors, wrong URL and unauthorized clients.
Node infrastructure guards require the native CI step and prohibit extension ACL
mutations in the application migration. Existing five-file/93-case unit gates,
no-network digest, canonical 58 migrations/checksums and unrelated features stay
unchanged. Actual results and environment limitations are recorded in the ZIP.

Rollback: keep flags/runtime/cron off; revert the Edge/consumer release if later
deployed; retain additive state and evidence. Do not revoke shared pg_net grants,
remove managed triggers, delete shared `project_url`, or roll back a provider's
grant policy without a separate cross-dispatch review. No hosted action occurred.

The security section above supersedes conflicting pre-correction notes below.

26 October 2026. **No hosted operations, deployment, schedule activation or flag activation.**
Contract: [PR #58 comment 6405221297](https://github.com/vivek2310sharma/FairSwap-Backend/pull/58#issuecomment-6405221297).
Local observed HEAD remains `213b57c84e2b3767e3ab3499846dd280bf3315c3`;
the read-only PR snapshot reports `0b5644f0269e5cfee17c06f10a05a10a38837b32`.
No fetch/pull or synchronization was performed. ChatGPT must reconcile the scoped
Phase 1B delta onto that PR, preserving newer unrelated main/PR work. The user
explicitly authorized local CI/package/config changes for this phase; no GitHub
branch, commit, workflow execution or PR mutation was performed.

## Phase 1B files and behavior

- `supabase/functions/process-chat-safety/{index.ts,deno.json}`: POST-only Edge
  entrypoint, exact Supabase JS 2.116.0/Zod 3.24.2 npm pins and explicit `.ts`
  imports. It invokes the existing `src/lib/chat-v2/safety-worker.ts` core.
- `supabase/functions/_shared/chat-safety-worker-handler.ts`: injectable handler.
  Method and credential-format checks happen before configuration/client creation.
  The **only** DB call permitted before authentication succeeds is the service-only
  Vault verification RPC. Strict boolean true with no RPC error is required before
  claim/complete; false/null/truthy strings/errors/exceptions fail closed. No
  body-selected URL, token, batch size, Bearer fallback or raw error reflection.
  Responses are generic/no-store; authenticated success exposes aggregate counts
  only. Neither handler nor core logs tokens, messages, URLs or raw RPC errors.
- `supabase/config.toml`: only the new function gets `verify_jwt=false`. Existing
  function gates are unchanged. Custom-header Vault auth is mandatory even though
  the platform JWT check is disabled.
- New CLI-generated forward-only migration
  `supabase/migrations/20261026073143_chat_safety_worker_infrastructure.sql` in
  this isolated directory, after the unchanged Phase 1 migration. It adds the
  verifier, private runtime/recovery state, indexed bounded recovery, service-only
  metrics, owner-only dispatcher and inactive provisioning function. The original
  58 migrations, their manifest and Phase 1 migration are unchanged.
- `release/fairswaptest.inactive.sql` and `release/fairswapprod.inactive.sql`:
  separately reviewed, owner-run setup artifacts, **not auto-applied migrations**.
  They validate the exact existing Vault `project_url`, allowed environment and
  all five flags off; create a separate 32-byte random credential in Vault if
  missing; preserve an existing valid credential; bind runtime to that environment;
  create/update one named cron job; and commit it inactive in the same transaction.
  Repeating setup preserves the credential and resets dispatch/schedule inactive.
  Wrong-environment, duplicate or malformed Vault setup fails closed. Setup does
  not return a credential or place one in cron command text.
- `.github/workflows/backend-ci.yml`: separate required `chat-v2` job with frozen
  dependency installation, isolated Node tests, strict transport/core typecheck,
  and standalone PostgreSQL harness. The aggregate success job requires all three
  jobs. Existing unit-integrity and PG15 jobs, action pins, 58-file integrity
  gates, five Vitest files/93 cases and no-network setup digest stay intact.
  `scripts/ci/db-verification.test.mjs` now requires the three-job dependency
  list and the extra Chat V2 success condition; every former assertion remains.
- `package.json`, `pnpm-lock.yaml`, `scripts/ci/toolchain.json`: exact Backend
  dev dependency `@electric-sql/pglite` **0.5.8**, frozen integrity resolution.
  `scripts/ci/test-chat-v2.mjs` imports it directly; there is no sibling Web or
  external repository requirement.
- `tests/chat-v2/{edge-auth.test.mjs,infrastructure-contract.test.mjs,offline-guard.mjs}`,
  plus the existing safety tests and expanded DB harness: transport authorization,
  CI/pin guards, queue/lease/backlog/RLS and inactive release assertions. The new
  offline guard blocks fetch and socket connections, failing the process on an
  attempted connection; the original five-file Vitest network guard is unchanged.

## Auth, metrics and bounded recovery

Environment-variable names: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (existing
Supabase-hosted defaults). Vault names: `chat_safety_worker_secret`, `project_url`.
No worker dispatch secret is stored in Edge env or shipped to browsers/native
clients. Dispatch uses `x-chat-safety-worker-secret`; it sends **no service-role
key**, API key or Bearer token. The current server client uses the existing legacy
service-role hosted default; `sb_secret_` and `sb_publishable_` values are rejected
in that slot, never treated as JWTs. A future new-key migration needs an explicitly
reviewed API-key-header client contract.

`verify_chat_safety_worker_secret(candidate)` and `chat_safety_metrics()` are
service-role-only public invoker wrappers over private definer implementations
with fixed empty search paths. Neither accepts a client-selected recipient or
returns credential/message contents. Verification rejects missing/duplicate/bad
Vault credentials and old credentials after rotation. Runtime, recovery state,
dispatcher and setup have no client/service direct grants; only DB owner can
configure/schedule them. Jobs remain accessible solely through service RPCs.
The new tables have forced RLS and revoked client grants.

Metrics return pending/due/leased/exhausted/completed counts, cumulative scanned,
recovered (missed-insert repair) and enqueue-failure counts, sweep count and the
last scan's size/time. A fifth lease is still leased until its deadline; only then
is it exhausted. No automatic retry or token acceptance occurs after exhaustion.
Exact queue metrics may scan the job table: review monitoring frequency/cost at
release. Missing jobs not yet reached by the sweep are not presented as an exact
global missing count. Recovered totals and failed-trigger counters are the
content-free missed-insert monitoring signals.

Each enabled claim locks one private recovery-state row and scans **at most 100
source messages** in `(created_at,id)` order between a durable cursor and a fixed
per-sweep high-water tuple. The indexed `LIMIT 100` materialized CTE runs **before**
conversation joins and the missing-job anti-join. The final source tuple advances
the cursor even for ineligible/already-queued rows. At the high-water tuple/end,
the cursor resets; late commits/backdated messages behind it are revisited on a
later sweep. A fixed horizon prevents continuing arrivals from extending the
current sweep forever. The recovery-state row lock serializes only this bounded
DB work; queue selection retains `FOR UPDATE SKIP LOCKED`, 20 claims maximum,
five attempts, exponential delays and idempotent completion.

Automated PGlite `EXPLAIN (FORMAT JSON)` requires `Limit` plus an index condition
using `chat_safety_recovery_messages` for the row-range query. It uses
`enable_seqscan=off` to assert availability of that plan, not to claim a production
optimizer choice. Verify actual hosted plans/statistics after authorization;
index creation itself may require a controlled lock window on a large table.
Legacy delivery never fails because a warning enqueue failed; a safe counter
records that event and the bounded sweep repairs missing jobs.

`pg_net` temporarily stores the dispatch credential in its request queue. The
application migration does not change extension-owned grants; a read-only guard
blocks new Chat dispatch/provisioning while that queue is exposed. The dispatcher
is owner-only, builds its URL from a two-value environment allowlist, and reads
the token only after the guard succeeds. Resolve the provider-supported protected
transport blocker before release;
do not log request headers, DB RPC parameters, Vault data or net queue contents.

## Phase 1B automated checks and release constraints

Run from Backend, with its own frozen dependencies installed:

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts --engine-strict
node --test tests/chat-v2/*.test.mjs
node scripts/ci/test-chat-v2.mjs
corepack pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions src/lib/chat-v2/safety-worker.ts supabase/functions/process-chat-safety/index.ts
corepack pnpm typecheck
corepack pnpm test:unit
```

The handoff contains actual command results. PGlite runs real Phase 1 and 1B SQL
with explicit account/listing/Vault/cron/net fixtures; those fixtures do not prove
Vault encryption, pgcrypto randomness, real cron activation, pg_net delivery or
Deno-hosted execution. Strict TypeScript covers the entrypoint and imports; the
actual Deno runtime is NOT RUN here. PG15 native-Linux rehearsal is NOT RUN on
Windows. Existing CRLF checkout limitations remain distinct from canonical Git
blob verification; no gate or historical byte is changed to mask a failure.

The PR contract reports Test 87 / Prod 71 ledger entries and required extensions
on 26 October; those are PR-reported facts, not freshly queried hosted evidence.
Backend hosted release authority/standing staging delivery remains unresolved.
No source patch or green local check authorizes hosted execution.

ChatGPT-managed release order after review/automated CI:

1. Reconcile the Phase 1B delta onto PR #58 and rerun all old/new CI gates. Verify
   exact Test/Prod ledgers, protected deployment ownership, backup/forward-fix
   readiness, extension capabilities and relevant net/Vault grants. Prepare
   isolated environment-specific migrations; never push the historical chain.
2. Apply the two isolated forward migrations to **FairSwapTest first**, deploy
   the worker inactive, then run the Test inactive setup artifact under explicit
   release authority. Validate its existing Vault `project_url` first; if absent,
   resolve that owner provisioning prerequisite without copying production data.
   No secrets are printed or checked into SQL. All five flags stay off.
3. After automated Test evidence, repeat reviewed forward-only release and the
   distinct inactive setup artifact for **FairSwapProd**. The migration/setup
   creates no active schedule. Cron names are `chat-safety-fairswaptest` and
   `chat-safety-fairswapprod`; interval is one minute only after future activation.
4. Enabling the cron job, private runtime `dispatch_enabled`, and warning flag
   requires separate coordinated release authority and compatible recipients/
   policy prerequisites. Rich media, meetup pin and seller sale flow stay off.

Rollback: disable the warning flag, set runtime dispatch off and deactivate the
environment's named cron job; revert the Edge/consumer release while retaining
additive objects, queue state and evidence. Vault credential rotation revokes old
dispatch tokens. No destructive down-migration, secret deletion or evidence loss.
After production deployment the owner checks availability and recipient-only
warnings; those are post-deployment checks, never a manual predeployment gate.

Current release blockers: protected hosted authority/ledger reconciliation,
actual extension/Deno/pg_net execution evidence, environment Vault prerequisite
review, and compatible consumer/policy readiness before warning activation.
CI workflow execution awaits ChatGPT integration. No local code blocker is
intentionally waived; actual failed or unavailable checks are listed in the ZIP.

References: [scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions),
[authorization headers](https://supabase.com/docs/guides/functions/auth-headers).

## Historical Phase 1 snapshot (superseded where Phase 1B above differs)

25 October 2026. **Not applied, deployed, activated, or release-approved.**

Observed Backend checkout: `main`, HEAD `213b57c`. No fetch/pull, branch,
commit, PR, hosted inventory, or GitHub operation was performed. This is an
observed local base, not a verified synchronized release base. Existing Posting
V2, profile, taxonomy, and other uncommitted work was preserved. Web already has
uncommitted inbox/thread changes; no Web file was edited by this phase.

The downloaded `FairSwap_Chat_V2_Implementation_Plan.md` supplied the requested
product scope. Its historical baseline and execution suggestions were treated as
design input, not authority to deploy, change hosted state, rewrite native clients,
or supersede repository ownership and freeze rules.

## Implemented contract

The CLI generated
`supabase/migrations/20261025204922_chat_v2_inbox_and_safety.sql` in **this isolated
directory**, outside the immutable 58-file migration baseline. Do not push this
directory or the historical directory directly to a hosted project.

- Private flags `inbox`, `safety_warnings`, `rich_media`, `meetup_pin`, and
  `seller_sale_flow` all default off. The last three reserve capabilities only;
  this migration supplies no rich-message, location, or sale writer.
- `public.chat_v2_inbox(tab,page_size,cursor_at,cursor_id,listing_id,query_text,unread_only)`
  returns `{items,counts,has_more,next_cursor}`. Tabs are `all`, `buying`, `selling`;
  the page size is 1–50. Counts are conversations matching search/listing scope,
  before tab/unread filtering and pagination. Search is a literal case-insensitive
  substring, at most 100 characters; `%` and `_` are not wildcard syntax.
- Selling groups are aggregated before cursor pagination. Buying stays flat.
  An item has `id`, `conversation_id` (null for groups), `listing_id`, `is_group`,
  `enquiry_count`, `unread_count`, `is_selling`, `last_message_at`, `listing`,
  `peer_name`, `preview`, and `preview_is_own`. A group has no peer name. Its ID
  is its latest conversation ID; its stable product grouping key is listing ID.
  Listing metadata contains title/slug/status/price in paise and a cover photo ID
  only when the existing public-visibility helper permits it. No storage paths,
  signed URLs, or profile details are returned. Previews are capped at 160 chars.
- Passing `listing_id` drills into enquiries and requires the listing owner.
  Group unread totals include all matching conversations, even when the unread
  filter hides other rows. A search for a counterparty narrows the matching
  enquiries and counts; the UI must not label these filtered counts as all-time.
- Inbox cursor ordering is `(last_message_at,id)` descending. Send both fields
  from `next_cursor` unchanged. This is a live keyset, not a frozen snapshot:
  incoming messages can move a conversation/group to the front. On Realtime
  activity, consumers refresh the first page and deduplicate by conversation ID
  or selling listing ID instead of concatenating duplicate groups.
- `public.chat_v2_messages(conversation_id,page_size,cursor_at,cursor_id)` returns
  ascending `items` for each newest-first page (1–100), plus `has_more`,
  `next_cursor`, and `peer_read_cursor` (`{at,id}` or null). Use the oldest tuple
  to load preceding messages. Seen means the peer tuple reaches the latest own
  message; clients compare the entire timestamp/UUID tuple. Fetching does not
  mark read; keep the existing visible-thread `mark_conversation_read` flow.
- Read RPCs require an authenticated active/suspended participant. Removed/sold
  history remains readable under the existing account and conversation rules;
  a deleted counterparty remains a distinct `Deleted user` state.
- A default-off message trigger enqueues recipient safety jobs for *every*
  existing message writer, including the legacy RPC. It never alters send
  results or blocks delivery on a queue failure. A bounded service recovery pass
  repairs missing jobs, including historical text after activation. Classification
  delivery is eventually consistent; it is not a synchronous send check.
- Service-only `chat_safety_claim(batch_size)` claims 1–20 jobs with fresh lease
  tokens, `FOR UPDATE SKIP LOCKED`, exponential retry delays (120, 240, 480, 960,
  1920 seconds), and five attempts maximum. Claim content stays server-side.
  `chat_safety_complete(message_id,lease_token,rule_ids)` derives the recipient
  from the job, rejects unknown rule IDs and stale/expired tokens, and atomically
  commits findings and completion. Empty rule arrays complete benign messages
  without findings. Duplicate completion with the same token is harmless.
- `public.message_safety_findings` has recipient-only SELECT RLS, no client
  writes, and is **not** added to Realtime publication. Account status,
  participant membership, and the kill switch are checked on reads. Senders and
  outsiders cannot read it. No raw text/URL/number is stored in a finding.
- The canonical `india-fraud.ts` exports chat-only `classifyIndiaChatSafety`
  (`chat_india_v1`, eight fixed signal IDs) without changing the existing listing
  classifier contract. Hindi, English and Hinglish advice/negation fixtures are
  covered; the rules remain heuristic cautions, not fraud determinations.
- `src/lib/chat-v2/safety-worker.ts` injects a service RPC client, validates claimed
  batches with Zod, classifies text, and completes by message ID and lease token.
  It loads no environment, makes no provider calls, and emits no content/error-body
  logs. This is a worker core, **not a deployed/scheduled Edge endpoint**.

## Local automated evidence

Run from Backend with Node 24.15.0 and the already installed dependencies:

```powershell
node --test tests/chat-v2/safety.test.mjs tests/v2-single-project/india-fraud.test.mjs
node scripts/ci/test-chat-v2.mjs
corepack pnpm test:unit
corepack pnpm typecheck
corepack pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions src/lib/chat-v2/safety-worker.ts src/lib/moderation/v2/india-fraud.ts
```

- PASS: 34 new classifier/worker tests plus 14 existing India-fraud tests (48).
- PASS: 34 disposable PGlite PostgreSQL checks execute the real baseline
  communication DDL/RPCs and the new migration. Coverage includes 230 messages,
  121 enquiries on one ad, 110 additional inbox rows, unread/Seen cursors,
  deleted-counterparty state, recipient RLS, unauthorized calls, leases,
  exhausted retries, missed-trigger recovery, and disabled flags.
- PASS: existing Vitest suite, 5 files / 93 tests, with its no-network setup.
- PASS: existing TypeScript check and the explicit new-module TypeScript check.
- FAIL (pre-existing checkout format): `corepack pnpm verify:migrations` rejects
  the first manifest line because the manifest and all 58 SQL files have CRLF
  worktree line endings. Read-only verification of **all 58 HEAD Git blobs**
  matches the pinned SHA-256 manifest. Neither the baseline nor verifier was
  edited; this does not turn the failed worktree command into a pass.

The PGlite harness substitutes account status, listing visibility, notification,
and minimal profile/listing fixtures. It omits only the Realtime publication
statement from baseline communication SQL. This is not the full Supabase
extension/auth stack, real worker transport, concurrent-session acceptance,
native acceptance, or a hosted migration rehearsal. The native-Linux database
runner was not run on Windows. No manual/exploratory tests were performed.

The new Node/PGlite tests have explicit commands and are **not automatically in
the existing CI workflows or Vitest include list**. Owner-controlled CI wiring
is still required; no workflows, manifests, lockfiles, or toolchain gates were
changed. The PGlite runner reuses the installed Web dev dependency without
editing Web; make its dependency available in the isolated release verifier.

## Next implementation and release dependencies

1. Reconcile the observed checkout with outstanding Posting V2 work and inspect
   actual Test/Prod ledgers under separately authorized read-only operations.
   The plan's 25 October hosted observations were not independently rerun here.
   Resolve Backend standing staging-delivery ownership; it remains unresolved.
2. Add authenticated, scheduled Edge transport for the safety worker using the
   approved least-privilege/secret contract. Add operational counts for backlog,
   exhaustion and missed inserts without content logs. Review recovery query
   cost against realistic hosted data before activation; the bounded recovery
   result can still scan historical messages. No new secrets are needed by this
   local slice; worker transport configuration remains unresolved.
3. Wire the split inbox and native read-compatible consumers against these RPCs,
   preserving existing local Web changes, deep links, state, Realtime refresh,
   accessibility, IST display, retry IDs and visibility-based reads. Add automated
   consumer contract tests and CI integration before enabling inbox.
4. Implement the remaining plan separately: private media processing/gateway,
   fail-closed PDF scanning, attachment reporting/Admin evidence, genuine-reply
   meetup gate, seller outcome/outbox, rich readers before writers, Help Center,
   reviewed legal policy/version updates and retention/hold decisions. No claim
   of compatibility or feature completion for these surfaces is made here.
5. ChatGPT owns GitHub branches, commits, PRs and deployment orchestration. Under
   the existing hosted freeze/release controls, assemble reviewed environment-
   specific forward-only artifacts; rehearse and apply to FairSwapTest first,
   then FairSwapProd, keeping flags off. Never push the raw historical chain.
   Only activate shipping capabilities after automated gates and their worker/
   reader/policy prerequisites. This document grants no hosted authority and
   adds no owner manual-test gate before deployment.

Rollback: disable the relevant private flags, stop the safety worker, and revert
the consumer/worker release while retaining additive database objects. Existing
text messaging remains unchanged. Do not drop evidence or apply destructive SQL
without a separate data-preservation review. Reserved rich flags must stay off
until their server/DB writers and policy prerequisites exist.

Owner checks after production deployment: grouped/ungrouped conversation counts,
deep-link navigation, responsive panes, unread and Seen display, and recipient-
only caution visibility. These checks are future post-deployment availability
checks, not current verification or a predeployment approval request.

Database implementation follows the current [Supabase function security guidance](https://supabase.com/docs/guides/database/functions)
and [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).
