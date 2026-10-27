# Ratings V1 launch readiness plan

Scope: Backend automated verification and release handoff only, 27 October 2026.
Preserve existing dirty work, six Ratings migration bytes, APIs, policies and CI.
No fetch, hosted access, migration reapplication, feature activation or release actions.

1. Reuse the isolated Ratings fixture runner and its real SQL migrations. Extend
   coverage for identity/role authorization, direct DML denial, deadline boundaries,
   all score combinations, publication backlog, reminder cursor and rollback.
2. Run offline contract and database checks; attempt the existing disposable native
   PG17 harness. Clearly distinguish emulated Auth/JWT/cron from hosted acceptance.
3. Deliver exact task diff, results, coverage limits, environment names, staging-first
   release instructions, monitoring and rollback. No new database migration expected;
   any discovered contract defect becomes an explicit blocker rather than a silent
   edit to deployed SQL.

Local HEAD observed: 213b57c84e2b3767e3ab3499846dd280bf3315c3. Not synchronized.
PR #59 merged and six migrations deployed are user-reported facts.
