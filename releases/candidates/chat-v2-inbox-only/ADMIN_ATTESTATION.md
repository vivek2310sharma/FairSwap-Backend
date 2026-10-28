# Automatic owner authorization and protection audit

The manual V2 comment/JSON attestation procedure is retired. No issue comment,
CHAT_RELEASE_ADMIN_ATTESTATION_JSON, manually refreshed ledger JSON, initial failing
audit or rerun is required. Owner dispatch plus the existing GitHub Environment
approval gates authorize the scoped foundation release to Test and Production.

Both original and triggering actors must be vivek2310sharma. Only the exact reviewed
main SHA and bundle are accepted. GET-only live audits validate the complete
collaborator inventory (owner sole administrator), main-only environment branches,
owner reviewer, self-review allowed, administrator bypass disabled and environment
secret-name isolation. They validate active main-owner-only-updates (25821687) with
exactly deletion/non-fast-forward/update rules and the existing bypass tuple
RepositoryRole/5/always, plus active protect-main (25352225) with PR creation,
stale-review dismissal, zero required independent approvals, every configured CI
context including backend-ci-success and chat-inbox-native-pg17, and no bypasses.
Configured/effective check inventories must agree. No branch checks are removed.

Ruleset bypass lists must be visible and exact. Missing metadata, denied APIs,
unknown rulesets, incomplete pagination, privileged collaborators, changed scope or
unexpected bypasses fail closed. Two complete inspections must have identical
fingerprints. No manual statement substitutes for inaccessible metadata. A read
identity that cannot see bypass lists requires appropriate metadata visibility;
this task does not change token permissions or GitHub protections.

Each deployment automatically captures its own current environment-specific ledger,
then retains exact ledger drift, identity, PG17, atomic CLI and postflight checks.
Schema 3 receipts replace owner-comment hashes with automatic protection snapshot
hashes and captured ledger digests. Production validates the same-run Test receipt
and its independent trusted job outputs before any Production audit or DB use.
Optional audit-only mode needs no ledger or database password and makes no claim
about hosted DB/Web flags. It is not a prerequisite for deploy mode.

The owner has approved existing Supabase credentials, multiple deploy tools, no
backups and both environments for this release. Exclusive authority transfer and
old-token revocation are not asserted or prerequisites for this scoped release.
Full setup, variables, production verification and rollback are in PROTECTED_RELEASE.md.
