# Chat V2 foundation: one-dispatch protected release

Owner authorization for this release permits existing Supabase credentials, multiple
deploy tools, no backups, and deployment to both environments. It does not establish
old-token revocation or exclusive Backend deployment authority. No hosted action was
performed while preparing these files.

## Dispatch and order

After ChatGPT reviews and lands the changes with all required branch checks intact,
the owner dispatches once on main: deploy=true, audit_only=false, approved_sha equal
to the immutable workflow SHA, and bundle_sha256 from bundleHash() at that commit.
No ledger inputs, audit preparation run, comment, attestation JSON or successful-run
rerun is required. Optional audit_only=true remains GET-only and never deploys.

Order: automatic native PG17/CLI and offline checks -> protected FairSwapTest ->
automatic Test postflight and receipt -> same-run receipt validation -> protected
FairSwapProd -> automatic Production postflight and receipt. Existing GitHub
Environment approval protections still apply independently to each environment;
there is no additional owner testing or staging sign-off requirement.

## Variables and credentials

- Keep repository variable CHAT_INBOX_RELEASE_ENABLED=true for the authorized
  release (default absent/false otherwise).
- Keep environment variables CHAT_INBOX_ENVIRONMENT_ENABLED=true and
  CHAT_WEB_FLAG_OFF_CONFIRMED=true in both environments. The Web confirmation must
  reflect the deployed Web flag being OFF; the Backend does not inspect or alter Web.
- Add required environment variable CHAT_DB_POOLER_HOST separately to FairSwapTest
  and FairSwapProd. Copy only the host from each project's Dashboard Connect ->
  Session pooler; never infer it from region or use a full URI. The two values may
  match when projects share a pooler cluster; project-specific usernames still differ.
- Keep existing environment-only secrets CHAT_DATABASE_PASSWORD and
  CHAT_RELEASE_AUDIT_TOKEN. No Supabase credential rotation is needed.
- Add environment-only secret CHAT_DB_SSL_ROOT_CERT_PEM independently to FairSwapTest
  and FairSwapProd, containing the matching project's downloaded root CA certificate
  as actual multiline PEM (not a path, private key, literal backslash-n text or URI).
- Remove obsolete environment variables CHAT_APPROVED_LEDGER_JSON,
  CHAT_RELEASE_ADMIN_ATTESTATION_JSON and CHAT_BACKEND_AUTHORITY_RECEIPT.
- Add variable: CHAT_DB_POOLER_HOST in each environment. Remove dispatch inputs test_ledger_sha256/prod_ledger_sha256.

The audit identity needs complete live read access to repository/collaborator,
ruleset (including bypass lists), environment/branch and secret-name metadata.
Omitted bypass lists, denied APIs or incomplete pagination are genuine unverifiable
protection failures, never substituted with comments or presumed empty lists.
Keep main-only environments, sole-owner reviewers, self-review allowed,
administrator bypass disabled, both existing rulesets and every required CI check.
No source code in this release changes GitHub configuration or removes checks.

Both psql and CLI migration fetch/up use that same shared Supavisor session host,
port 5432, database postgres and username postgres.<expected-project-ref>. There is
no fallback to the direct IPv6 host or transaction pooler port 6543. Passwords remain
in process environment, never URI arguments, SQL, receipts or printed diagnostics.
TLS stays verify-full (hostname and certificate verification) using only the supplied
project CA. The runner validates one PEM CA certificate and its validity period,
writes it exclusively to root.crt (0600) inside a fresh private directory (0700),
and points both PGSSLROOTCERT and the CLI sslrootcert parameter at that same file.
The whole attempt is wrapped in cleanup, including audit/configuration/CLI/SQL
failures and success. No system CA fallback or TLS downgrade is supported. PEM
bytes are not forwarded to subprocess environments, arguments, logs or receipts.
OS permissions are enforced on the Ubuntu release runners; Windows unit checks do
not claim to verify POSIX access restrictions. Forced process termination is handled
by disposal of the GitHub-hosted runner rather than JavaScript finally cleanup.

Missing/malformed configuration fails before API/database work (after the Production
receipt gate). Diagnostics use only fixed codes:
CHAT_SUBPROCESS_<STAGE>_<CATEGORY>_RECOVERY_REVIEW. Stages identify CLI_VERSION,
CLI_APPLY_HELP, CLI_FETCH_HELP, HISTORY_CAPTURE, PREFLIGHT_BEFORE_FETCH,
HISTORY_FETCH, PREFLIGHT_BEFORE_APPLY, MIGRATION_APPLY and POSTFLIGHT.
Categories distinguish DNS_FAILURE, TCP_FAILURE, TLS_CERTIFICATE_FAILURE and
AUTHENTICATION_FAILURE. Generic connection failures remain CONNECTION_FAILURE;
migration SQL, history and permission failures retain their specific allowlisted
categories (for example UNEXPECTED_SQL_FAILURE at MIGRATION_APPLY). No raw
subprocess text, SQL, hostname, certificate content, password or full URI is emitted.
See [Supabase session pooler connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

## History, identity and atomic execution

No new migration or reviewed SQL source change. Reuse source version 20261025204922
and its pinned original SHA. The source/bundle hashes, PG17 requirement, fixed
project identities and verify-full TLS remain mandatory. Before planning each
environment, a read-only repeatable-read transaction captures its current complete
version/name/statement-array hashes; no historical SQL or user data enters artifacts.
The snapshot is validated for the expected project, source base, freshness and
ledger shape. Existing candidate history requires protected recovery, never replay.

CLI 2.117.0 fetches genuine applied history into a private isolated PG17 workspace.
Exact ledger checks run before and after fetch, again under the transaction-scoped
history lock in the pending execution, and after apply. Concurrent/history drift,
missing or extra fetched versions, dependency/catalog/identity failures and partial
or foreign candidate state block release. The CLI owns atomic schema/history
recording; no manual insert, repair, fabricated history, raw-directory db push or
replacement migration version is allowed. Private fetched SQL is deleted afterward.

Production downloads the Test artifact by its trusted job output ID, verifies
SHA256SUMS and the independently supplied receipt digest, then validates schema 3,
owner actors, source/bundle, run ID/attempt, source version, CLI/PG17, execution,
protection/history hashes, five OFF flags, Web OFF confirmation and captured Test
ledger digest from the trusted Test job output before Production API/database access.
Receipts contain only sanitized metadata/hashes and use exclusive-create files and
unique run/attempt artifacts with overwrite=false and 90-day retention.

## Production verification and rollback

Automatic postflight must prove PG17, exact unchanged noncandidate history,
CLI-recorded version/name/nonempty statements and execution marker, expected
function bodies/owners/security modes, grants, participant RLS, indexes, empty
safety state, no new worker runtime and all five database flags OFF: inbox,
safety_warnings, rich_media, meetup_pin, seller_sale_flow. Web Chat stays OFF.
No schedulers, workers or feature activation are deployed. ChatGPT checks the
successful Production job and sanitized receipt for the approved SHA/bundle/run,
version, history/ledger hashes and OFF evidence; no manual/exploratory testing.
Hosted results remain NOT RUN until orchestration actually executes.

Rollback: disable Chat flags, git revert/restore previous deployment; retain additive
schema, messages and migration history (never erase additive history).

A real failure blocks dependent Production work. After an ambiguous apply, use
protected automated verify/recovery rather than blindly rerunning CREATE statements;
this is failure recovery, not a required second dispatch on the success path.

Owner-reported history difference: FairSwapTest includes DigiLocker version
20261028091220; FairSwapProd does not. Runtime capture uses each target independently
and preserves that difference; this task did not query either hosted ledger.
