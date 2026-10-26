# Ratings V1 local handoff

Implemented additive server-owned transaction/review domain, RLS/grants, immutable
reviews/replies, double-blind publication, aggregates, typed chat events, deduplicated
reminders, case-scoped AAL2 staff controls and privacy export/erasure. All activation
settings and schedules remain OFF by default. No hosted, GitHub or manual test actions.

Base HEAD: `213b57c84e2b3767e3ab3499846dd280bf3315c3`, observed branch `main`.
No fetch/pull/synchronization. Exact starting dirty inventory is included.
Six unrelated Chat V2/CI paths changed concurrently; see their hash receipt. They are
excluded from this handoff's source payload. No Chat V2 implementation dependency.

Final automated checks: 37 native PostgreSQL 17.6 checks (including independent-session
concurrency and both environment release guards), 34 supplementary PGlite checks,
four contract tests including all 64 face combinations, 93 existing unit tests, existing
and scoped TypeScript checks: PASS. Canonical 58 historical Git blob hashes: PASS.
Standard Windows manifest verifier: FAIL on pre-existing CRLF format. Historical files
and their pinned manifest were not changed; existing CI gate remains in place.

Changed source: five forward migrations and SQL security checks under
`supabase/forward-migrations/ratings/`; two TypeScript modules under `src/lib/ratings/`;
contract `docs/contracts/ratings-v1.md`; standalone tests/tooling under `tests/ratings/`;
two new root package scripts; release metadata/evidence in this directory.
`changed-files.json` is the exact inventory; `scoped.diff` includes new source plus only
the package-script delta relative to the exact starting dirty package. The full
`package.json` snapshot also contains unrelated pre-existing dependency work: apply
the scoped delta, rather than replacing the integration checkout's package wholesale.
`SHA256SUMS` hashes every payload file other than itself.

Staging order: schema `20261026083608`, RPCs `20261026083610`, reads `20261026083612`,
jobs `20261026083613`, reporting/privacy `20261026083614`, then staging inactive setup.
Production order: the same five additive versions on its separately verified isolated
production baseline, then production inactive setup. Separate manifests/receipts and
identity guards are included. Compatible consumers precede each environment's activation.
New environment variables: **NONE**.

Release remains blocked by documented deployment-ownership/ledger/backup gates,
full environment regression/load qualification, ChatGPT-owned CI integration and
compatible consumer releases. Hosted pg_cron, Supabase Data API and consumer acceptance
were not run. Optional profile-onboarding exporter composition requires installed
definition/ACL verification at release; no unmerged onboarding changes are imported.
No unresolved source collision with Chat V2 was found; concurrent unrelated files are
not part of this payload. Do not apply the raw historical migration chain.

Rollback: disable Ratings flags and scheduled jobs; revert affected consumer deployment;
preserve additive ratings data pending reviewed rollback. See `RELEASE.md` and
`checks.json` for precise prerequisites, evidence limits and automated owner checks.

ZIP destination: parent workspace `ratings-v1-backend-handoff.zip`.
