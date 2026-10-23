# Support-ticket state RPC — source candidate

Forward-only candidate, **not permission to deploy or apply**. The 58 immutable historical
migrations and existing release ledgers are unchanged. The version `20261023162940` was issued by
`supabase migration new` (CLI 2.117.0, the pinned version) in an isolated scratch workspace.

## Problem

`public.admin_update_ticket_status(ticket_id, status, priority, assigned_to)` writes
`assigned_to` on every call. Admin's mitigation reads the current assignee and replays it, which
loses a concurrent reassignment committed between that read and the write.

## Contract

```
public.admin_update_ticket_state(ticket_id uuid, status support_ticket_status_enum, priority support_ticket_priority_enum) returns void
app_security.impl_staff_update_ticket_state(p_ticket_id uuid, p_status ..., p_priority ...) returns void
```

- Public wrapper: `SECURITY INVOKER`, `search_path=''`. Implementation: `SECURITY DEFINER`, `search_path=''`.
- Grants: `EXECUTE` to `authenticated` only on both functions. Revoked from `PUBLIC`, `anon`, `authenticated`
  (then re-granted explicitly) and `service_role`. No new service-role path.
- Body order: `auth.uid()` present (`42501 Not authenticated`) → `is_active_staff_aal2('support_agent')`
  (`42501 Forbidden: requires active support agent with AAL2`; administrator satisfies it; covers active account, aal2, role)
  → non-null arguments (`22023`) → `SELECT … FOR NO KEY UPDATE` (`P0002 Support ticket not found`) → `UPDATE` of
  `status`, `priority`, `updated_at` only → one audit event.
- Authorization precedes the existence check, so unauthorized callers cannot probe for tickets.
  Messages carry no ticket id, subject, assignee or table/column names. Legacy messages are reused verbatim;
  error codes are new (legacy used the default `P0001`).
- Audit: one `support_ticket.updated` / `support_tickets` event, details
  `{status, priority, previous_status, previous_priority}`. It deliberately omits `assigned_to` (this RPC
  neither reads nor writes it). Consumers that expected `assigned_to` in details for this action will see it
  only on legacy-RPC events.
- Concurrency: `assigned_to` is absent from the `UPDATE` column list, so after waiting on a row lock PostgreSQL
  re-reads the latest committed row and keeps its assignment (READ COMMITTED). `FOR NO KEY UPDATE` serialises
  state writers without blocking `support_messages` inserts (FK `FOR KEY SHARE`). Under REPEATABLE READ or
  SERIALIZABLE a concurrent change would raise `40001` rather than lose data; callers must not auto-retry
  (none is added here).
- The legacy RPC is untouched. A legacy call still overwrites status/priority/assignee as before.
- No tables, columns, indexes, policies or triggers are created or changed. RLS is unchanged.

The migration begins with `begin; set local lock_timeout='5s'; set local statement_timeout='30s';`, runs a
preflight (required objects exist, new functions do not), and ends with a privilege guard before `commit`.
It uses plain `create function`, so a re-run fails closed.

## Test and Production ledgers

Test (FairSwapTest, 61 migrations = 58 source + 3 Test-only) and Production (FairSwapProd, 52 migrations
= 45 baseline + 7 forward, final `20261017205807`) have **different histories**. Never run
`supabase db push` from `supabase/migrations/`. For each environment the release owner must:

1. Build an isolated workspace for that environment's exact ledger (Production: the verified 52-version
   workspace) and add only this file, keeping the CLI-issued version. It sorts after every existing version
   in both ledgers.
2. Compare against the live ledger read-only, and confirm the legacy `admin_update_ticket_status` signatures
   and `support_tickets` columns exist as the preflight expects.
3. Apply to **Test first**; run authenticated AAL2 acceptance (state update preserves assignee; AAL1,
   non-staff and anon refused; one audit event). Then Production in an authorized release window with a
   verified backup.

Nothing was executed against any hosted project. The candidate depends on migrations 01, 02, 03 and 13
objects only (all present in both environments by AGENTS.md ledgers; hosted presence is UNVERIFIED here).

Rollback / forward-fix: after Admin stops calling it,
`drop function public.admin_update_ticket_state(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum);`
then the `app_security.impl_staff_update_ticket_state` equivalent, in a separately reviewed migration.
Data is never altered by this candidate, so no data rollback exists.

## Disposable verification

`tests/support-ticket-state/run-disposable.mjs` starts a throwaway PostgreSQL bound to `127.0.0.1` on a
random port with a random password in a temp directory, loads reduced Supabase stubs plus the **actual
immutable migrations 01, 02, 03 and 13**, applies this candidate and runs 17 tests, including real
two-connection lock-order concurrency (waiting is confirmed via `pg_stat_activity`). It accepts no URL or
credentials.

```sh
node tests/support-ticket-state/run-disposable.mjs \
  --embedded-postgres-module /abs/path/embedded-postgres/dist/index.js \
  --pg-module /abs/path/pg/lib/index.js
```

`embedded-postgres` (17.10) and `pg` are local test tooling installed outside the repo, not Backend
dependencies. `--emit-sql` prints the fixture, migrations and candidate for a fresh CI-only database.
Not wired into CI (workflows are owner-controlled). It is not a full 58-migration or real Supabase Auth
reconstruction, and not PG 15.8/17.6 hosted parity.

## Required follow-up in FairSwap-Admin (not done here)

After this is installed in the target environment, Admin (PR #24) must:

1. Replace the status/priority mutation's `rpc('admin_update_ticket_status', …)` with
   `rpc('admin_update_ticket_state', { ticket_id, status, priority })`. Delete the read-and-replay of
   `assigned_to`; send no `assigned_to` key.
2. Keep reassignment on the legacy RPC only if it remains a separate action. Note it also overwrites
   status and priority, so a reassign should pass values it just read and accept last-writer-wins on those
   fields, or a dedicated assignment RPC should be added later.
3. Mutation validation: zod-parse `ticket_id` (uuid), `status` and `priority` against the enum values
   (`open|in_progress|awaiting_user|resolved|closed`, `low|normal|high|urgent`); reject unknown keys, so
   `assigned_to` cannot be passed. Map `42501`, `22023` and `P0002` to generic user messages.
4. Regenerate Supabase types so `Database['public']['Functions']['admin_update_ticket_state']` exists
   (Args: `ticket_id`, `status`, `priority`; Returns `undefined`), via Web's generated `database.ts` process.
5. Tests: mutation calls the new RPC with exactly three args; no assignment read or replay; error mapping;
   validation rejects bad enums/ids; legacy RPC not used by the status/priority path.
6. Ship Admin only after the Backend function is live in that environment (Test, then Production).
