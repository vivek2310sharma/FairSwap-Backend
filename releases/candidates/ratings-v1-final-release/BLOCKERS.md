# Ratings V1 non-backup release blockers

Backup/restore: WAIVED_BY_OWNER in both environment records for this release only.
No backup existence or successful restore is claimed. Irreversible data loss,
downtime, limited recovery and no guaranteed point-in-time recovery are accepted risks.

| Gate | Current disposition / closure evidence |
|---|---|
| HDR-03 missing statement array | RECONCILED by merged PR #49 SQL, exact deployment receipt and recreated installed contract; narrow Production-only fail-closed exception. NULL history preserved. |
| Full hosted identity preflight | BLOCKED for BOTH projects: RATINGS_ENVIRONMENT_MISMATCH at existing Vault project_url guard. Do not bypass or change hosted config here; separately review identity evidence and rerun full preflight. |
| Exact historical source provenance | BLOCKED: full independently reviewed 87/71 source-byte/workspace mapping unavailable. Six Ratings files match reviewed PR; HDR-03 reconciled. Other unavailable evidence is not invented. |
| Exclusive Backend migration operator | BLOCKED: named approved principal, separate project permission metadata, human approval/release window, reviewed hashes, concurrency lock and auditable execution/rollback authority not supplied. |
| No overlapping legacy deployment authority | BLOCKED: inventory Web staging/main Actions secrets/environments, Vercel deploy integrations, Supabase memberships, external runners, manual Windows/Mac identities, database principals and break-glass paths using metadata only. Prove revocation/restriction before Backend grant, with provider audit/revocation records and authorized non-writing negative permission checks. Four legacy PAT revocations remain owner-attested; no token values requested. Preserve necessary runtime keys. |
| Mandatory new remote CI gate | BLOCKED until ChatGPT integrates scoped workflow change at reviewed PR head, all old gates pass and ratings-hosted-readiness-pg17 passes in backend-ci-success. Local automated results do not establish remote execution or branch protection. |
| Existing worker-trigger EXECUTE review | OPEN: public.handle_listing_moderation_enqueue / app_security.trg_fn_notify_moderation_worker broad grants need independent risk disposition; Ratings does not mutate them. |
| Full installed-chain and performance qualification | NOT RUN / BLOCKED pending authoritative source reconstruction and approved automated load/catch-up qualification; reduced PG17 fixtures are not a hosted clone. |
| Consumer release/activation evidence | UNVERIFIED: Web/Admin staging/production mapping, flags, focused build IDs and automated compatibility/security/availability evidence. No manual testing or extra owner staging approval required. |

Read-isolated Backend tokens and old one-off installs do not establish exclusive
migration authority. A missing deploy script does not prove absent account authority.
Evidence contains principal/token IDs, scope metadata, timestamps, status codes and
restricted audit references only. Never expose old PAT values, runtime keys, Vault
values or database connection credentials. Never perform a write merely to prove denial.
