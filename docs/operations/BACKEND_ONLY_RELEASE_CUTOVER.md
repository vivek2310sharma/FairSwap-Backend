# Backend release authority and scoped Chat V2 exception

## Current scoped authorization — 28 October 2026

The owner authorizes the Chat V2 foundation release using existing Supabase
credentials, multiple deploy tools and no backups, in FairSwapTest then FairSwapProd.
This authorization supersedes older exclusive-transfer, token-retirement, backup,
manual-attestation and owner-staging-testing prerequisites for this release only.
It does not claim old credentials are revoked, privileged writers are retired or
exclusive Backend authority has transferred. Broader ownership cutover remains
unverified; keep necessary Web runtime keys and existing CI/environment protections.
No hosted deployment, GitHub administration, commit or push occurred in preparation.

ChatGPT owns branch/commit/push/PR/merge and hosted orchestration. The one-dispatch
workflow is prepared locally, not installed or dispatched by this task. All existing
branch checks, including backend-ci-success and chat-inbox-native-pg17, remain required.
FairSwapTest and FairSwapProd retain their separate owner approval protections.
No manual/exploratory testing or owner testing before deployment is required.

## Chat V2 deployment contract

Use the reviewed main source SHA and bundle digest. A single deploy dispatch runs
automatic native PG17/CLI checks, Test deployment/postflight, validates its immutable
same-run/attempt receipt, then Production deployment/postflight. No preliminary
failing audit, manually prepared comment/JSON, manual ledger update or success-path
rerun. Existing credentials and environment names are retained. Current Test and
Production histories are captured independently at runtime, never inferred from
historical migration counts or copied between projects.

No new SQL migrations; reviewed foundation source 20261025204922 is unchanged.
Use isolated authentic CLI-fetched history plus the single guarded candidate,
exact ledger/identity/dependency guards, atomic CLI-managed history, RLS/catalog
checks and automatic postflight. Never apply the mixed raw historical directory,
fabricate/repair ledger entries or erase additive history. Existing candidate state
or discrepancies stop the workflow for protected automated recovery.

All five new database Chat flags and Web Chat remain OFF. No scheduler or worker
activation. Production verification checks the approved source/bundle/run/attempt,
PG17, unchanged prior history, CLI candidate history/execution marker, expected
RLS/grants/catalog and OFF evidence in the successful automated receipt.
Hosted acceptance remains NOT RUN until the protected workflow executes.

Variables to add: none. Retain CHAT_INBOX_RELEASE_ENABLED,
CHAT_INBOX_ENVIRONMENT_ENABLED and CHAT_WEB_FLAG_OFF_CONFIRMED; remove obsolete
CHAT_APPROVED_LEDGER_JSON, CHAT_RELEASE_ADMIN_ATTESTATION_JSON and
CHAT_BACKEND_AUTHORITY_RECEIPT. Retain environment-only CHAT_DATABASE_PASSWORD and
CHAT_RELEASE_AUDIT_TOKEN. The GitHub audit token must expose complete protection
metadata, including bypass lists; unavailable evidence fails closed.

Rollback: disable Chat flags, git revert/restore previous deployment; retain additive
schema, messages and migration history, never erase additive history.

See [protected release procedure](../../releases/candidates/chat-v2-inbox-only/PROTECTED_RELEASE.md)
and [automatic protection audit](../../releases/candidates/chat-v2-inbox-only/ADMIN_ATTESTATION.md).

Owner-reported history difference: FairSwapTest includes DigiLocker version
20261028091220; FairSwapProd does not. Runtime capture uses each target independently
and preserves that difference; this task did not query either hosted ledger.
