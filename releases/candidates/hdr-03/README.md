# HDR-03 unread-count contract — source candidate

For Web Draft PR #234 and review `5627179716`. This is an isolated forward-only
candidate, not permission to deploy. Backend has no staging branch; review targets
`main`. The 58 immutable historical migrations and existing release ledgers stay
unchanged. The timestamp was generated with `supabase migration new` in a separate
local source workspace.

## RPC and unread semantics

`public.get_unread_counts()` takes **no arguments** and derives identity from
`auth.uid()`. Only `authenticated` can execute it; missing identity or a status
other than active/suspended raises `42501`. Both fields are non-negative bigint
counts, checked against JavaScript's maximum safe integer before return.

`unread_messages` counts **individual incoming messages**, not conversations.
Own messages are excluded. A retained message with a deleted/null sender still
counts as incoming. A message is unread if its `(created_at, id)` is greater than
the message identified by the caller's per-conversation read marker. Missing
markers mean all inbound messages are unread. The marker's `last_read_at` is the
time of the read request and is deliberately not used as a message cursor. The
tuple ordering agrees with the existing monotonic mark-conversation-read RPC.
`unread_notifications` counts only the caller's rows with null `read_at`.

Unlike write helpers, this read aggregate is intentionally **SECURITY INVOKER**
with an empty search path. Existing table SELECT grants and RLS remain effective;
it cannot recover rows denied by source-table policies. It uses existing indexed
conversation participants, message `(conversation_id,created_at,id)`, read-state
primary keys and notification owner/unread indexes. No message bodies are read.

## Minimal Realtime invalidation

The review found no published read-state table and no notification on message
arrival. This candidate adds `unread_count_signals(id, user_id, revision)`, with forced
owner-only SELECT RLS, no client writes and no anonymous access. Only this new
minimal table is added to the existing `supabase_realtime` publication. Inbound
message INSERT triggers increment recipients' counters; read-marker INSERT or a
changed marker increments that owner's counter. An unchanged marker does not
signal. Existing notification events continue to refresh notification totals.

The primary key is a random opaque signal ID, not the owner ID; replica identity
stays at default, so a deletion tombstone cannot reveal the owner ID. Supabase
Realtime DELETE events do not apply row SELECT RLS, so Web subscribes only to
INSERT/UPDATE. A malicious DELETE subscription could observe opaque tombstones,
not identities, counts or message/read contents. Never change replica identity to
FULL without revisiting this contract.

Web listens with an owner filter and refetches the aggregate; it never downloads
message content, subscribes to all message rows, or publishes private marker IDs.
Trigger functions have no client EXECUTE grant. Existing message/read RPCs retain
their account, membership and policy checks. Signal writes happen transactionally
with the underlying change and failures abort it, so there is no silent lost
invalidation. No trigger queues email or creates synthetic user notifications.

One signal row per recipient bounds storage. Realtime event payloads remain small,
although events still scale with message/read activity. Web coalesces overlapping
refreshes rather than polling. Account-deletion cascades and administrative message
deletions are not new message-arrival signals; route changes/reconnects refresh
the authoritative aggregate. The two header counts are a statement snapshot,
not a client-maintained tally.

## Disposable verification

`tests/hdr-03/run-disposable.mjs` composes reduced local Auth/listing prerequisites,
the **actual immutable notification and communication migrations 10 and 11**, this
forward candidate and SQL assertions. It is not a full 58-migration reconstruction
or a real Supabase Auth/Realtime service. Local in-memory PostgreSQL execution:

```sh
node tests/hdr-03/run-disposable.mjs --pglite-module /absolute/local/path/to/pglite/dist/index.js
```

PGlite is a local test runtime, not a new Backend dependency. A narrow GitHub Actions
workflow runs the same SQL on a **fresh PostgreSQL 17.6 service database** using
loopback psql and a synthetic CI-only password, with no hosted secrets or deploy
step. The runner can emit SQL for that fixture; it accepts no database URL or
credentials. Do not feed its fixture SQL to any existing or hosted database.

Assertions cover anonymous/missing identity/restricted accounts, no ID overload,
invoker execution and underlying RLS, cross-user count/signal isolation, denied
signal/helper writes, exact zero, multi-message and timestamp-tie counts, arrival
after reading, read-marker changes/no-op, notification reads and minimal publication.

## Release dependencies and remaining gates

Both hosted environments still require separately authorized isolated preflight,
reviewed migration installation, and real authenticated two-user/two-tab RPC and
Realtime acceptance. This task performs none of those operations. Do not run this
candidate or the raw historical baseline against hosted projects. Test/Production
ledgers intentionally differ; the future release owner must choose isolated,
environment-specific workspaces and verify all expected tables, indexes, policies,
function signatures, trigger ownership and publication before installation.

Web must ship its owner signal subscription alongside this contract, and its
notification-only fallback remains necessary until the RPC is deployed. Backend
source PR acceptance does not change Web's pinned Backend CI source or deploy the
RPC. Keep both PRs Draft for independent code/security review.

Rollback requires a separately reviewed removal of the three new triggers, two
internal trigger functions, aggregate RPC and the new publication table. Do not
roll back underlying messages, notifications or read states. No rollback or hosted
installation is executed here.
