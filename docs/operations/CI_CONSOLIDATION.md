# Backend CI consolidation

Active workflows: `backend-ci.yml`, `reusable-supabase-release.yml` (GitHub Free-compatible,
separate FairSwapTest / FairSwapProd credentials, unchanged) and the manual read-only
`backend-scoped-token-check.yml`. Never exceed five.

## Archived (bytes unchanged) in `docs/operations/archived-workflows/`

Retired: `chat-v2-inbox-release`, `fsw-sec-003-{prelaunch,protected-release,evidence-audit}`,
`deploy-azure-moderation`, `deploy-google-moderation`, `azure-moderation-ci`.
Merged into `backend-ci.yml`: `chat-inbox-native-pg17`, `chat-v2-inbox-pg17`, `idv-v1-native-pg17`,
`admin-moderation-analytics-db-tests`, `profile-onboarding-db-tests`, `hdr-03-production-package`.

### Historical evidence

The archived workflow files are byte-identical to their previous versions, but that does **not** keep the
combined source hashes unchanged, because other hashed inputs changed in the same patch:

- FSW-SEC-003 evidence audit: `sourceHash()` also covers `fsw-sec-003-evidence-audit.mjs`,
  `inbox-protection.mjs` and `tests/fsw-sec-003/evidence-audit.test.mjs`. All three changed, so the value differs
  from any earlier run. Only the file lookup changed (the receipt `workflow` identity string and hashed label are
  unchanged); the hash algorithm and `verifyReceipt` semantics are untouched.
- Chat inbox `bundleHash()` covers `run-chat-inbox-pg17.sh`, `inbox-protection.mjs` and
  `tests/chat-v2-inbox-only/protected-release.test.mjs`, which changed; the two Chat workflow files now resolve from
  the archive. A previously approved bundle SHA no longer matches.

Both receipts are bound to a freshly computed hash inside a single run and expire after 24 hours, and both
workflows are disabled, so no existing receipt is re-verified against current source. Existing receipt files and
their verification code are unmodified. Re-enabling either workflow would require re-approving the new hash.

## `backend-ci.yml` jobs

| Job | Notes |
| --- | --- |
| `changes` | Fail-open filter (`scripts/ci/changed-areas.mjs`): unknown paths and unverified file lists run the database jobs; only docs, root Markdown and `src/` can skip, and only the literal `false` from an uncapped GitHub compare of the event base SHA to the exact tested merge SHA excuses a skip (non-ancestor, malformed or 300-file-capped results run both jobs). Everything under `supabase/` (every forward migration), `docs/extraction/` (migration manifest), `scripts/`, `releases/`, `tests/` and `.github/` is always relevant. |
| `unit-integrity` | Unchanged checks plus HDR-03 package verification; pnpm cache. |
| `database-pg15`, `forward-db-pg15` | Docker Supabase PG 15.8. Skipped only when `changes` proves them irrelevant. `forward-db-pg15` runs Moderation Analytics and profile-onboarding pgTAP, each on its own fresh stack after a ledger check proves the clean baseline; one CLI download is shared. |
| `ratings-native-pg17` | One checksum-pinned PG 17.6 install and one Supabase CLI install shared by Ratings, Posting, Tablets, Wearables, Taxonomy, public search, IDV, HDR-03 and Chat inbox. No step is conditional. |
| `ratings-hosted-readiness-pg17`, `chat-inbox-native-pg17` | Gate jobs; `chat-inbox-native-pg17` keeps the existing required-check name. |
| `backend-ci-success` | Required aggregate. Every job must be `success`; `database-pg15` / `forward-db-pg15` may be `skipped` only if `changes` succeeded and its output is exactly `false`. A skipped security job otherwise fails the gate. |

PR runs cancel when superseded; `main` runs never cancel. Routine artifacts keep 7 days.

## Known limits

- PG15 is kept temporarily; no additional PostgreSQL tooling was built.
- Linux-only scripts (`run-idv-pg17.sh`, `run-hdr03-pg17.sh`, `run-chat-inbox-pg17.sh --pg-bin`, `run-forward-packages-db.sh`) and the Corepack/pnpm cache are unverified until a hosted run.

- The PG15 Supabase-image suites (baseline, 9 pgTAP suites, security snapshot, Moderation Analytics, profile
  onboarding) are not on PG17. The pinned prebuilt PG17 is stock PostgreSQL: no pgTAP and none of the
  `pg_net`, `pg_cron`, `supabase_vault` extensions that the 58 baseline migrations create. Moving them needs new
  pinned tooling and a reviewed fidelity decision.
- The runtime target is not demonstrated; it needs a hosted run to measure.
