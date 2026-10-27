# Ratings consumer-contract handoff

Observed local base SHA: `213b57c84e2b3767e3ab3499846dd280bf3315c3`, branch `main`.
No synchronization/fetch/pull. User-reported PR #59 base:
`d5cc399d2b8e0ae3f3fcc91c800bcc2be4d7af19`; it is not the local HEAD.

Diff summary: one additive migration; safe listing/trade context and public names on
review DTOs; participant-only conversation lookup; typed review/Not rated Given-history
RPC; role/AAL2/flag-gated metadata-only staff queues; Zod/regression coverage; portable
native PG17 runner, checksum-pinned source builder and unapplied CI job proposal.

Changed source files and exact before/after digests: `changed-files.json`.
Source-only patch relative to the local initial Ratings source: `scoped.diff`.
Full payload SHA-256 manifest: `SHA256SUMS`. Existing five migrations are unchanged
prerequisites from PR #59 and deliberately absent from this delta ZIP. Release plans
reference all six hashes (raw local bytes and normalized LF for imported Git sources).
No unrelated root package/lock/config/CI/workflow or Chat V2 files are included.
`preservation.json` compares every pre-existing file outside this delta byte-for-byte.
Six CI/Chat V2 files changed concurrently during this task; before/current hashes are
recorded, their current bytes are untouched and excluded. The six unrelated changes
recorded by the initial Ratings handoff also remain untouched and excluded. No overlap
with this delta requires conflict resolution.

Automated PASS: native PG17.6 46 checks, supplementary PGlite 43 checks, contract 5 tests,
existing unit 93 tests, scoped/root TypeScript, both Bash syntax checks, and 58 canonical
historical Git blobs/EOL conversions. Details/commands/logs: `checks.json`.
Existing raw-byte baseline verifier still FAILS on the unchanged Windows CRLF checkout;
its CI gate was preserved. Linux native source-build/job execution, full Supabase
histories, actual cron/Data API, load/consumer/hosted acceptance: NOT RUN.

Staging and production have independent manifests, preflights and receipt templates.
Exact order, authorization/environment prerequisites, one-line rollback and automated
owner production checklist: `RELEASE.md`. All flags OFF, no new environment variables,
no activation/backfill/phone/OTP/cooldown restriction, no hosted/GitHub mutation.

ChatGPT owns integrating `ci-pg17.yml.example` without weakening existing CI and adding
its required aggregate gate. GitHub delivery, consumer implementations and authorized
release execution remain separate. No owner manual testing or staging approval gate
was added.
