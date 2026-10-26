# Chat V2 inbox release

The current operational runbook is [Protected release](PROTECTED_RELEASE.md). It
supersedes the initial direct-ledger/psql operational path from PR60. The original
foundation source/version remains byte-identical to PR58; all five flags stay off.

Repository visibility is verified public. Backend-only release authority, effective
branch/environment approval and credential-scope protections remain unverified.
The manual workflow is disabled by default and cannot deploy without successful
native PG17/CLI verification, immutable approvals, Test evidence and separate Prod
approval. Existing CI gates, package pins and 58 historical migrations are unchanged.

See [original source manifest](manifest.json), [protected plan](PROTECTED_PLAN.md),
[CI integration](CI_INTEGRATION.md) and the handoff test evidence/blockers. Legacy
render().apply is an offline regression fixture only; the old apply entrypoints and
CLI exporter fail closed. No runtime flags or hosted resources changed locally.
