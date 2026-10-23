# Support-ticket state RPC — source candidate

Forward-only candidate, **installed only through the separately authorized Test and Production releases recorded below**. This source document does not authorize any further migrations or application deployments. The 58 immutable historical
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

## Test and Production installation records (23 October 2026)

This one additive SQL candidate was installed **separately** on FairSwapTest and FairSwapProd.
Its CLI-generated source version is `20261023162940`. The connected Supabase migration API
issued a different hosted version in each project. SQL source is the same reviewed Git blob
`ae8f2dd6d249e19df64d16504d68dd83337b6da5` (SHA-256
`e8ce62aa1bf997ae0a1b9de2f98e05f3adb3f44d3e5b852ea7c6ac6d3986febd`).

| Environment | Pre-install ledger | Hosted migration version | Post-install ledger |
| --- | ---: | --- | ---: |
| FairSwapTest (`wpppxlnbzqynvhpeuavd`) | 74 | `20261023184548_support_ticket_state_v1` | 75 |
| FairSwapProd (`kriuhwppxgxsyyrbjsau`) | 58 | `20261023193856_support_ticket_state_v1` | 59 |

The older Test 61 / Production 52 figures and interim Production 57 ledger are historical,
**not current**. The Production baseline was independently advanced by HDR-03 migration
`20261023160752_hdr03_production_unread_counts` before this installation.
See the dated receipts `test-installation-20261023.json` and
`production-installation-20261023.json`; the Test receipt's earlier Production status is
a preserved historical snapshot taken *before* the Production installation.

For each installation the operator verified the exact project identity, a healthy PG17.6
database, the current live ledger, legacy RPC/schema/staff/audit prerequisites, absence of
the new functions, a matching reviewed SQL blob, and successful GitHub Backend CI.
Migrations were applied through the connected Supabase migration API, **not**
`supabase db push` from the 58 immutable historical migrations.

Both projects passed postflight checks: exactly two new functions, correct INVOKER/DEFINER
security modes, fixed empty search paths, EXECUTE only for authenticated, no EXECUTE for
anon/PUBLIC/service_role, and no `assigned_to` references. Definition digests match
between Test and Production. Neither migration changes ticket data, table policies, RLS,
triggers or the legacy RPC. Existing security-advisor findings were 49 in Test and 50 in
Production both before and after; there were no CRITICAL/ERROR findings.

**Owner-accepted Production recovery risk:** The owner explicitly excluded a backup/PITR
verification from this release and accepted that risk, with intent to handle backups later.
The recovery point and an isolated restore rehearsal were **NOT VERIFIED**. This waiver
was limited to the *single additive state-RPC migration*; it does not grant standing
Production SQL privileges or waive security checks for future releases.

**Remaining application and runtime gate:** A real authenticated Test/Production AAL2
support-agent ticket state update, AAL1/nonstaff negative tests, and the expected audit
behavior have **NOT RUN against hosted user sessions**. Existing Admin PR #24 still calls
the legacy status RPC until a separately reviewed Admin mutation change replaces it with
`admin_update_ticket_state` and removes the pre-read/replayed assignment. Thus the
new functions are safely available in both databases, **but the live Admin user flow is
not yet concurrency-safe**. Do not claim complete application remediation or deploy
the Admin cutover without its own CI, preview, and controlled acceptance.

For future releases, read each live migration ledger again and use a separate,
environment-specific, reviewed and authorized forward migration plan. Never run
`supabase db push` from the immutable 58-file source directory or reuse the old
52-version Production workspace.

Rollback/forward-fix: Once no application caller depends on the new RPC, remove
`public.admin_update_ticket_state(uuid, public.support_ticket_status_enum,
public.support_ticket_priority_enum)` and then its private
`app_security.impl_staff_update_ticket_state` counterpart only through a separately
reviewed and authorized forward migration. There is no ticket-data rollback
for this function-only installation, and no verified Production backup point from
this release.

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
