import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => readFileSync(path.join(root, p), 'utf8');
const MIG = 'supabase/migrations/';
const CANDIDATE = 'releases/candidates/support-ticket-state-v1/supabase/migrations/20261023162940_support_ticket_state_v1.sql';
const sources = [
  'tests/support-ticket-state/fixture.sql',
  MIG + '20260914000001_create_accounts_and_profiles.sql',
  MIG + '20260914000002_create_staff_and_security.sql',
  MIG + '20260914000003_create_audit_and_privacy.sql',
  MIG + '20260914000013_create_support_and_appeals.sql',
];

if (process.argv[2] === '--emit-sql' && process.argv.length === 3) {
  process.stdout.write([...sources, CANDIDATE].map(read).join('\n'));
  process.exit(0);
}
const a = process.argv;
if (!(a.length === 6 && a[2] === '--embedded-postgres-module' && a[4] === '--pg-module')) {
  throw new Error('Use --embedded-postgres-module <abs entry> --pg-module <abs entry>, or --emit-sql. No URL/credential option exists.');
}
const load = async p => import(pathToFileURL(path.resolve(p)).href);
const EmbeddedPostgres = (await load(a[3])).default;
const pgMod = await load(a[5]);
const { Client } = pgMod.default ?? pgMod;

// Ephemeral loopback-only server in a throwaway directory with a random password.
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const password = randomBytes(18).toString('hex');
const dir = mkdtempSync(path.join(tmpdir(), 'fairswap-ticket-state-'));
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'fixture_admin', password, port, persistent: false, postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off'] });

const results = [];
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { failed++; results.push(['FAIL', name + ' :: ' + (e.message ?? e)]); }
};
const newClient = async () => { const c = new Client({ host: '127.0.0.1', port, user: 'fixture_admin', password, database: 'postgres' }); await c.connect(); return c; };

const U = {
  agent: '00000000-0000-4000-8000-000000000001', admin: '00000000-0000-4000-8000-000000000002',
  moderator: '00000000-0000-4000-8000-000000000003', editor: '00000000-0000-4000-8000-000000000004',
  plain: '00000000-0000-4000-8000-000000000005', suspendedAgent: '00000000-0000-4000-8000-000000000006',
  pendingAgent: '00000000-0000-4000-8000-000000000007', assigneeA: '00000000-0000-4000-8000-0000000000a1',
  assigneeB: '00000000-0000-4000-8000-0000000000b2', owner: '00000000-0000-4000-8000-0000000000c3',
};
const SECRET_SUBJECT = 'Confidential subject ZZ-SECRET-SUBJECT';
const MISSING = '20000000-0000-4000-8000-000000000000';
const STATE_SIG = 'uuid,public.support_ticket_status_enum,public.support_ticket_priority_enum';
let admin;

// Run one statement as a Supabase-like caller in its own transaction; returns {ok,error,rows}.
async function call(who, sql, params = []) {
  const c = await newClient();
  try {
    await c.query('begin');
    await c.query(`set local role ${who.role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [who.claims ? JSON.stringify(who.claims) : '']);
    const r = await c.query(sql, params);
    await c.query('commit');
    return { ok: true, rows: r.rows };
  } catch (e) { await c.query('rollback').catch(() => {}); return { ok: false, error: e }; }
  finally { await c.end(); }
}
const as = (uid, aal = 'aal2') => ({ role: 'authenticated', claims: { sub: uid, aal, role: 'authenticated' } });
const setState = (who, id, st, pr) => call(who, 'select public.admin_update_ticket_state($1,$2,$3)', [id, st, pr]);
const q = async (sql, p = []) => (await admin.query(sql, p)).rows;
let seq = 0;
async function newTicket({ assigned = null, status = 'open', priority = 'normal' } = {}) {
  const id = `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  await admin.query(`insert into public.support_tickets(id,user_id,category,subject,status,priority,assigned_to,created_at,updated_at)
    values ($1,$2,'general',$3,$4,$5,$6,'2026-01-01','2026-01-01')`, [id, U.owner, SECRET_SUBJECT, status, priority, assigned]);
  return id;
}
const ticket = async id => (await q('select status::text, priority::text, assigned_to, updated_at from public.support_tickets where id=$1', [id]))[0];
const audits = id => q(`select actor_id, action, target_entity, details from public.audit_logs where target_id=$1 and action='support_ticket.updated' order by created_at`, [id]);
const auditCount = async () => Number((await q('select count(*) n from public.audit_logs'))[0].n);

async function waitBlocked(pid) { // true once another backend waits on a lock held by our open tx
  for (let i = 0; i < 100; i++) {
    const r = await q('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
    if (r[0]?.wait_event_type === 'Lock') return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
const openTx = async who => {
  const c = await newClient();
  const pid = (await c.query('select pg_backend_pid() p')).rows[0].p;
  await c.query('begin'); await c.query(`set local role ${who.role}`);
  await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(who.claims)]);
  return { c, pid };
};

try {
  await server.initialise(); await server.start();
  admin = await newClient();
  for (const s of sources) await admin.query(read(s));

  for (const [k, id] of Object.entries(U)) await admin.query('insert into auth.users(id,email) values ($1,$2)', [id, `${k}@example.invalid`]);
  await admin.query(`update public.user_accounts set account_status='suspended' where user_id=$1`, [U.suspendedAgent]);
  await admin.query(`update public.user_accounts set account_status='deletion_pending' where user_id=$1`, [U.pendingAgent]);
  for (const [k, role] of [['agent', 'support_agent'], ['admin', 'administrator'], ['moderator', 'moderator'], ['editor', 'content_editor'], ['suspendedAgent', 'support_agent'], ['pendingAgent', 'support_agent']])
    await admin.query('insert into public.staff_roles(user_id, role) values ($1,$2)', [U[k], role]);

  // Capture the legacy contract and unrelated ACLs before applying the candidate.
  const legacySql = fn => `select pg_get_functiondef(p.oid) def, p.proacl::text acl, p.proargnames, p.prosecdef from pg_proc p where p.oid = to_regprocedure('${fn}(uuid,public.support_ticket_status_enum,public.support_ticket_priority_enum,uuid)')`;
  const legacy = async () => [(await q(legacySql('public.admin_update_ticket_status')))[0], (await q(legacySql('app_security.impl_staff_update_ticket_status')))[0]];
  const aclSql = `select c.relname, c.relacl::text, c.relrowsecurity, c.relforcerowsecurity from pg_class c where c.relname in ('support_tickets','support_messages','audit_logs') order by 1`;
  const legacyBefore = await legacy(), aclBefore = await q(aclSql);
  const policiesSql = `select tablename, policyname, cmd, qual from pg_policies where tablename in ('support_tickets','support_messages','audit_logs') order by 1,2`;
  const policiesBefore = await q(policiesSql);

  await admin.query(read(CANDIDATE));

  await test('migration: candidate is transactional, lock/statement bounded, writes no assigned_to', async () => {
    const sql = read(CANDIDATE);
    assert.match(sql, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '30s';/);
    assert.match(sql, /commit;\s*$/);
    const fn = sql.slice(sql.indexOf('create function app_security'), sql.indexOf('revoke all on function app_security'));
    assert.doesNotMatch(fn, /assigned_to/);
    assert.doesNotMatch(sql, /\b(create|alter|drop)\s+(table|index|policy|trigger|type)\b/i);
  });

  await test('9: new RPC has no assignment parameter; expected security attributes', async () => {
    const r = await q(`select n.nspname, p.proargnames, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.proname in ('admin_update_ticket_state','impl_staff_update_ticket_state')`);
    assert.equal(r.length, 2);
    const impl = r.find(x => x.nspname === 'app_security'), pub = r.find(x => x.nspname === 'public');
    assert.deepEqual(pub.proargnames, ['ticket_id', 'status', 'priority']);
    assert.deepEqual(impl.proargnames, ['p_ticket_id', 'p_status', 'p_priority']);
    assert.equal(impl.prosecdef, true); assert.equal(pub.prosecdef, false);
    for (const f of r) assert.deepEqual(f.proconfig, ['search_path=""']);
  });

  await test('9: explicit grants: authenticated only; no PUBLIC/anon/service_role', async () => {
    for (const sig of ['public.admin_update_ticket_state', 'app_security.impl_staff_update_ticket_state']) {
      const oid = `${sig}(${STATE_SIG})`;
      const r = (await q(`select has_function_privilege('anon',$1,'EXECUTE') anon, has_function_privilege('authenticated',$1,'EXECUTE') auth,
        has_function_privilege('service_role',$1,'EXECUTE') svc,
        exists(select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid=$1::regprocedure and a.grantee=0) pub`, [oid]))[0];
      assert.deepEqual(r, { anon: false, auth: true, svc: false, pub: false }, sig);
    }
  });

  await test('9: legacy RPCs, table ACLs, RLS flags and policies unchanged by the candidate', async () => {
    assert.deepEqual(await legacy(), legacyBefore);
    assert.deepEqual(legacyBefore[0].proargnames, ['ticket_id', 'status', 'priority', 'assigned_to']);
    assert.deepEqual(await q(aclSql), aclBefore);
    assert.deepEqual(await q(policiesSql), policiesBefore);
    assert.equal(aclBefore.find(r => r.relname === 'support_tickets').relrowsecurity, true);
  });

  await test('9: legacy RPC still works and still assigns (compatibility)', async () => {
    const t = await newTicket({ assigned: U.assigneeA });
    const r = await call(as(U.agent), 'select public.admin_update_ticket_status($1,$2,$3,$4)', [t, 'in_progress', 'high', U.assigneeB]);
    assert.ok(r.ok, r.error?.message);
    assert.equal((await ticket(t)).assigned_to, U.assigneeB);
  });

  await test('1: existing assignee A remains A after a state update (agent and administrator)', async () => {
    for (const who of [U.agent, U.admin]) {
      const t = await newTicket({ assigned: U.assigneeA });
      const r = await setState(as(who), t, 'resolved', 'urgent');
      assert.ok(r.ok, r.error?.message);
      assert.equal((await ticket(t)).assigned_to, U.assigneeA);
    }
  });

  await test('2: unassigned ticket remains unassigned', async () => {
    const t = await newTicket();
    assert.ok((await setState(as(U.agent), t, 'in_progress', 'high')).ok);
    assert.equal((await ticket(t)).assigned_to, null);
  });

  await test('4: status, priority and updated_at update correctly', async () => {
    const t = await newTicket({ assigned: U.assigneeA });
    const before = await ticket(t);
    assert.ok((await setState(as(U.agent), t, 'awaiting_user', 'low')).ok);
    const after = await ticket(t);
    assert.equal(after.status, 'awaiting_user'); assert.equal(after.priority, 'low');
    assert.ok(after.updated_at > before.updated_at);
    assert.ok(Math.abs(Date.now() - after.updated_at.getTime()) < 60_000);
  });

  await test('8: exactly one correct audit event per successful update; no assignment claim', async () => {
    const t = await newTicket({ assigned: U.assigneeA, status: 'open', priority: 'normal' });
    const base = await auditCount();
    assert.ok((await setState(as(U.agent), t, 'closed', 'high')).ok);
    const ev = await audits(t);
    assert.equal(ev.length, 1); assert.equal(await auditCount(), base + 1);
    assert.equal(ev[0].actor_id, U.agent); assert.equal(ev[0].target_entity, 'support_tickets');
    assert.deepEqual(ev[0].details, { status: 'closed', priority: 'high', previous_status: 'open', previous_priority: 'normal' });
    assert.ok(!('assigned_to' in ev[0].details));
    assert.ok((await setState(as(U.admin), t, 'closed', 'high')).ok);
    assert.equal((await audits(t)).length, 2);
  });

  await test('5: missing ticket fails with generic error and creates no audit event', async () => {
    const base = await auditCount();
    const r = await setState(as(U.agent), MISSING, 'closed', 'low');
    assert.equal(r.ok, false); assert.equal(r.error.message, 'Support ticket not found'); assert.equal(r.error.code, 'P0002');
    assert.equal(await auditCount(), base);
  });

  const denied = [
    ['anonymous (role anon)', { role: 'anon', claims: null }],
    ['authenticated without subject', { role: 'authenticated', claims: { aal: 'aal2' } }],
    ['support agent at AAL1', as(U.agent, 'aal1')],
    ['administrator at AAL1', as(U.admin, 'aal1')],
    ['non-staff user at AAL2', as(U.plain)],
    ['moderator (wrong staff role)', as(U.moderator)],
    ['content editor (wrong staff role)', as(U.editor)],
    ['suspended support agent', as(U.suspendedAgent)],
    ['deletion-pending support agent', as(U.pendingAgent)],
  ];
  await test('6/10: unauthorized callers: 42501, no mutation, no audit, no ticket/schema leakage', async () => {
    const t = await newTicket({ assigned: U.assigneeA, status: 'open', priority: 'normal' });
    const before = await ticket(t), base = await auditCount();
    const leak = new RegExp(`${t}|ZZ-SECRET|support_tickets|assigned_to|${U.assigneeA}|${U.owner}|audit_logs|staff_roles|user_accounts`);
    for (const [name, who] of denied) {
      const r = await setState(who, t, 'closed', 'urgent');
      assert.equal(r.ok, false, name);
      assert.equal(r.error.code, '42501', `${name}: ${r.error.message}`);
      assert.doesNotMatch(`${r.error.message} ${r.error.detail ?? ''} ${r.error.hint ?? ''} ${r.error.where ?? ''}`, leak, name);
    }
    assert.deepEqual(await ticket(t), before);
    assert.equal(await auditCount(), base);
    const probe = await setState(as(U.plain), MISSING, 'closed', 'low'); // existence must not be probeable
    assert.equal(probe.error.message, 'Forbidden: requires active support agent with AAL2');
  });

  await test('6: anon and service_role are refused by privilege on both functions (no body runs)', async () => {
    for (const who of [{ role: 'anon', claims: null }, { role: 'service_role', claims: { role: 'service_role' } }]) {
      const w = await setState(who, MISSING, 'open', 'low');
      assert.equal(w.error.code, '42501'); assert.match(w.error.message, /permission denied for function admin_update_ticket_state/);
      const i = await call(who, `select app_security.impl_staff_update_ticket_state($1,'open','low')`, [MISSING]);
      assert.equal(i.error.code, '42501'); assert.match(i.error.message, /permission denied/);
    }
  });

  await test('10: null arguments fail generically (no column/schema leakage) and write no audit', async () => {
    const t = await newTicket({ assigned: U.assigneeA }); const base = await auditCount();
    for (const [st, pr] of [[null, 'low'], ['open', null], [null, null]]) {
      const r = await setState(as(U.agent), t, st, pr);
      assert.equal(r.ok, false); assert.equal(r.error.code, '22023');
      assert.doesNotMatch(r.error.message, /null value|column|violates|support_tickets/);
    }
    const r = await call(as(U.agent), 'select public.admin_update_ticket_state(null,$1,$2)', ['open', 'low']);
    assert.equal(r.error.code, '22023');
    assert.equal(await auditCount(), base); assert.equal((await ticket(t)).assigned_to, U.assigneeA);
  });

  await test('7: authorized support agent and administrator retain access', async () => {
    for (const who of [U.agent, U.admin]) {
      const t = await newTicket();
      const r = await setState(as(who), t, 'in_progress', 'normal');
      assert.ok(r.ok, r.error?.message);
      assert.equal((await audits(t))[0].actor_id, who);
    }
  });

  await test('3: concurrent reassignment vs state update, both lock orders, never loses the assignment', async () => {
    const agent = as(U.agent);
    const service = { role: 'service_role', claims: { role: 'service_role' } };
    const variants = [
      ['direct update', service, 'update public.support_tickets set assigned_to=$2, updated_at=clock_timestamp() where id=$1'],
      ['legacy RPC', agent, `select public.admin_update_ticket_status($1,'open','normal',$2)`],
    ];
    for (const [label, reassigner, reassignSql] of variants) {
      { // Order 1: reassignment holds the row lock; state update waits and must keep the NEW assignee.
        const t = await newTicket({ assigned: U.assigneeA });
        const R = await openTx(reassigner), S = await openTx(agent);
        try {
          await R.c.query(reassignSql, [t, U.assigneeB]);
          const pending = S.c.query('select public.admin_update_ticket_state($1,$2,$3)', [t, 'resolved', 'urgent']);
          assert.ok(await waitBlocked(S.pid), `${label}: state update should block behind reassignment`);
          await R.c.query('commit'); await pending; await S.c.query('commit');
        } finally { await R.c.end(); await S.c.end(); }
        const f = await ticket(t);
        assert.equal(f.assigned_to, U.assigneeB, `${label} order 1`);
        assert.equal(f.status, 'resolved'); assert.equal(f.priority, 'urgent');
        assert.equal((await audits(t)).length, label === 'legacy RPC' ? 2 : 1); // legacy reassignment logs its own event
      }
      { // Order 2: state update holds the row lock; reassignment waits; the NEW assignee persists.
        const t = await newTicket({ assigned: U.assigneeA });
        const R = await openTx(reassigner), S = await openTx(agent);
        try {
          await S.c.query('select public.admin_update_ticket_state($1,$2,$3)', [t, 'resolved', 'urgent']);
          const pending = R.c.query(reassignSql, [t, U.assigneeB]);
          assert.ok(await waitBlocked(R.pid), `${label}: reassignment should block behind state update`);
          await S.c.query('commit'); await pending; await R.c.query('commit');
        } finally { await R.c.end(); await S.c.end(); }
        const f = await ticket(t);
        assert.equal(f.assigned_to, U.assigneeB, `${label} order 2`);
        if (label === 'direct update') { assert.equal(f.status, 'resolved'); assert.equal(f.priority, 'urgent'); }
      }
    }
  });

  await test('3: concurrent state updates serialise; assignment preserved; one audit event each', async () => {
    const t = await newTicket({ assigned: U.assigneeA });
    const rs = await Promise.all([setState(as(U.agent), t, 'in_progress', 'high'), setState(as(U.admin), t, 'resolved', 'low')]);
    assert.ok(rs.every(r => r.ok));
    assert.equal((await ticket(t)).assigned_to, U.assigneeA);
    const ev = await audits(t);
    assert.equal(ev.length, 2);
    // The second writer's "previous" values equal the first writer's committed values (no stale read).
    assert.deepEqual(ev[1].details.previous_status, ev[0].details.status);
    assert.deepEqual(ev[1].details.previous_priority, ev[0].details.priority);
  });

  await test('3: an open state-update transaction does not block support_messages inserts', async () => {
    const t = await newTicket({ assigned: U.assigneeA });
    const S = await openTx(as(U.agent)), M = await newClient();
    try {
      await S.c.query('select public.admin_update_ticket_state($1,$2,$3)', [t, 'in_progress', 'normal']);
      await M.query(`set lock_timeout='1s'`);
      await M.query(`insert into public.support_messages(ticket_id, sender_id, content) values ($1,$2,'hello')`, [t, U.owner]);
      await S.c.query('commit');
    } finally { await M.end(); await S.c.end(); }
  });
} catch (e) {
  failed++; results.push(['FAIL', 'harness :: ' + (e.stack ?? e)]);
} finally {
  await admin?.end().catch(() => {});
  await server.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
for (const [s, n] of results) console.log(`${s}: ${n}`);
console.log(failed ? `FAIL: ${failed} failed of ${results.length}` : `PASS: support-ticket-state disposable PostgreSQL tests (${results.length})`);
process.exitCode = failed ? 1 : 0;
