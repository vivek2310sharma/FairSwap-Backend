# Chat V2 — local phase 1 candidate

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
node scripts/ci/test-chat-v2.mjs '../FairSwap-Web'
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
