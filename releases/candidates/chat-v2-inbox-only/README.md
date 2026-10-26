# Chat V2 inbox-only release

Prepared locally, 26 October 2026. **Not authorized or deployed.** Integration target:
`release/chat-v2-inbox-only`, based on `172abf80a20576d941a655a3726374b352570d6d`.
Local checkout HEAD differs; the handoff records it separately. This lane has no
dependency on PR #58's worker infrastructure, Edge deployment, dispatch credential,
pg_net queue restrictions, external schedule or `project_url` Vault entry.

## Exact foundation reuse and future conflict prevention

The sole foundation is the exact Git blob from Backend PR #58 head
`6320947671a0b0ebb1ea98285177e340c55cf025`:

| Item | Pinned value |
| --- | --- |
| Migration | `20261025204922_chat_v2_inbox_and_safety.sql` |
| SHA-256 | `f9807a4455601c14baff954836523c0cbd6ce3d478bed4071aeaca20ae67e852` |
| Git blob | `c27408d24436c7dbe6a2a9dde3d8716d91948fb3` |
| Version / ledger name | `20261025204922` / `chat_v2_inbox_and_safety` |

No split or renumbering is needed. Retaining the inert safety tables, recipient-RLS
policy, disabled enqueue trigger and service RPC definitions prevents duplicate
flag/index/function definitions when PR #58 is integrated later. These objects do
not create schedules, issue HTTP, provision secrets or activate warning processing.
The five flags start false. All eight rule identifiers remain inert source constants.

The canonical 58 historical migrations are untouched and are **never** a deployment
input for this lane. The original local PR58 candidate and all Phase1B/scheduler
files are also untouched. This candidate directory is an isolated release copy;
its `.gitattributes` prevents checkout newline conversion of the pinned SQL.

When ChatGPT later integrates PR #58, retain this **same version and exact bytes**.
Do not apply two source directories together, replay its CREATE statements, rename
it to a new timestamp or use `IF NOT EXISTS`/`CREATE OR REPLACE` to mask differences.
Supabase's ledger must already contain this version; later reviewed Phase1B files
are separate pending work and may not be included in this inbox release. Reconcile
the ledger/content before any future CLI application. This lane records the complete
original UTF-8 source as one `statements[]` element and the original name/version;
normal CLI version detection can recognize it without reapplying the body.

The renderer verifies source SHA-256/Git blob, removes only its outer BEGIN/COMMIT
for execution, and wraps the **unchanged inner DDL** plus ledger insertion in one
transaction. Its stored ledger source remains byte-for-byte the original including
transaction boundaries. This avoids a successful schema apply with a missing ledger
row. Exact replay verifies the stored body, all ten function bodies/owners/security
attributes, API grants, inactive flags/state and absence of worker infrastructure.
No DDL runs on replay. Drift, orphaned objects, different tool serialization or an
already-applied PR58 variant stops for a separately reviewed reconciliation. Never
repair a ledger merely to satisfy these checks or delete an applied version.

## Contract and security

`chat_v2_inbox` and `chat_v2_messages` retain their existing JSON/RPC signatures.
The former groups seller enquiries before limit/cursor, represents a seller listing
as a group only at two or more enquiries, leaves Buying rows individual, and supports
seller-only `listing_id` drilldown. Counts are matching **conversations**, independent
of page/group count. At this exact contract revision, search/listing filters affect
counts; the unread-only filter affects rows after grouping, not the tab totals.
This distinction is intentional compatibility and must remain clear in consumers.

Both RPCs check `auth.uid()`, participant/account status and the database inbox gate.
Read access supports active/suspended participants and preserves history when users
block each other. Blocking still prevents sends in either direction through the
unchanged `send_message`. Existing policy requirements, retry idempotency, sold/
reserved behavior and monotonic `mark_conversation_read` remain authoritative.
Messages are chronological with older-page cursors; peer/read ordering uses the full
PostgreSQL timestamp/UUID tuple. Fetching a page does not mark it read.

Public wrappers are SECURITY INVOKER; private implementations have an empty search
path and explicit grants. Clients cannot update flags or read private safety jobs.
Recipient findings remain gated by their independent false flag. No message bodies,
credentials or migration statements are exported by the ledger-capture query.

## Environment-specific preparation

| Artifact prefix | Project | Expected ref |
| --- | --- | --- |
| `fairswaptest` | FairSwapTest | `wpppxlnbzqynvhpeuavd` |
| `fairswapprod` | FairSwapProd | `kriuhwppxgxsyyrbjsau` |

The source entrypoints are independently runnable psql scripts. They reference only
their own `prepared/<environment>.*.sql` outputs; missing outputs fail closed. Fresh
exact hosted ledgers cannot be invented locally, so outputs are generated from
reviewed metadata immediately before an authorized release, not committed as stale
ready-to-run SQL. No connection or execution is performed by the renderer.

An independently approved, protected Backend operator first captures metadata using
`capture-ledger.readonly.sql` with `psql --no-psqlrc --tuples-only --no-align` into a
private review file. The query returns `observedAt` and each migration's version,
name and SHA-256 of its JSONB statement-array representation. Add only these fields:

```json
{
  "projectRef": "<matching nonsecret project ref>",
  "baseCommit": "172abf80a20576d941a655a3726374b352570d6d",
  "observedAt": "<exact capture timestamp>",
  "reviewEvidence": "https://github.com/vivek2310sharma/FairSwap-Backend/<review receipt>",
  "ledger": [{ "version": "<14 digits>", "name": "<exact name>", "statementsSha256": "<64 lowercase hex>" }]
}
```

The URI is provenance, **not approval enforcement or an authorization token**. The
protected release process must independently verify review and source SHA. Review
all ledger rows, not a count or prefix. The older docs' 61/52 counts are historical;
PR58 metadata now mentions 87/71, also not a fresh hosted audit by this task. No
count is hardcoded or assumed here. Capture requires authorized read access, not a
request to reveal any PAT, database password or migration bodies in chat/source.

Offline preparation from Backend root:

```powershell
node scripts/release/chat-v2-inbox-only.mjs fairswaptest <private-Test-reviewed-ledger.json>
node scripts/release/chat-v2-inbox-only.mjs fairswapprod <private-Prod-reviewed-ledger.json>
```

The renderer refuses stale (>24h), future, duplicate-version, wrong-project,
wrong-base, malformed and worker-phase snapshots. It refuses overwriting prepared
artifacts. SQL repeats the freshness and full-ledger comparison inside a lock-bound
transaction. Review/hash the rendered outputs and archive them with the protected
release receipt; no secrets belong in them. Changed ledgers require a new approved
snapshot and regenerated output, never weakened guards.

Identity checks read existing trusted Vault URL anchors `email_outbox_worker_url`
and/or `moderation_worker_url`, checking the exact environment origin and known Edge
path. Any duplicate or conflicting anchor fails; at least one is required. This
does not invoke either worker or touch their credentials/configuration. There is
no new Vault provisioning requirement. If an anchor is missing/mismatched, stop for
authorized identity reconciliation; do not substitute client claims or a caller-set
GUC. The operator must resolve to application owner `postgres`; no grants or role
workarounds are added to get past missing authority.

## Protected release prerequisites and order

Backend-only hosted release authority is **not transferred** according to the
repository's [cutover requirements](../../../docs/operations/BACKEND_ONLY_RELEASE_CUTOVER.md).
Existing repository-level scoped PAT read checks are not deploy authority, migration
permission or human approval. Legacy PAT revocation is owner-attested, with remaining
writer inventory/negative proof/recovery evidence unresolved. No credential transfer,
branch protection, environment, release workflow or approval is created by this task.

ChatGPT must obtain verified enforcement before any apply: protect `main` and the
release integration path against direct/force/bypass changes; require reviewed PRs,
stale-approval dismissal and `backend-ci-success` plus the new isolated tests. Run
release code from the reviewed immutable SHA only. Separate Test/Prod environments
must release their distinct least-privilege credentials only after human review,
prevent self-approval and admin bypass, restrict deployment refs and serialize each
environment. Audit absence of Web/external privileged writers and retain Web runtime
keys. Do not reuse repository-scoped tokens to route around missing protection.

GitHub plan/feature availability must be verified for this **private** repository.
Official docs state required deployment reviewers on Free/Pro/Team are public-only;
private environment/branch availability and enforceable approvals must be resolved
before release. A named environment alone does not enforce approval. See
[reviewing deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)
and [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
If required protection is unavailable, release stays blocked; do not bypass it.

1. Integrate additive source into the requested release branch; run all existing
   CI gates unchanged plus the isolated commands in `CI_INTEGRATION.md`.
2. Under separately granted authority, prepare fresh **FairSwapTest** ledger/hash,
   backup/recovery evidence and immutable approved artifacts. Use a protected psql
   service profile (credentials injected privately), `--no-psqlrc` and
   `fairswaptest.preflight.psql`, then `fairswaptest.psql`. Only this one candidate
   is installed; all five flags and Web `FAIRSWAP_CHAT_V2_INBOX_ENABLED` remain off.
3. Obtain authorized automated Test evidence for native PostgreSQL, grants, actual
   account/policy/listing contracts, ledger atomicity, existing sends/read state and
   no regression to other workers. No manual/exploratory gate is introduced.
4. Repeat independently for **FairSwapProd**, with its own fresh exact ledger,
   protected approval, recovery evidence, service profile and Prod entrypoints.
   No raw 58-file push and no Phase1B, Edge or scheduler deployment.
5. Only after compatible Backend deployment and passing automated gates may a
   separately authorized activation enable database `inbox` then Web
   `FAIRSWAP_CHAT_V2_INBOX_ENABLED`. No activation SQL is supplied. `safety_warnings`,
   `rich_media`, `meetup_pin` and `seller_sale_flow` remain false. Other experimental
   categories and unrelated feature switches are outside this release.

## Non-destructive rollback

Disable the Web flag immediately; if needed restore the previous Web deployment.
Use the matching generated rollback entrypoint under authorized Backend control to
disable only database inbox. Identity/role checks remain; unexpected activation of
other Chat flags stops this lane for a separately reviewed combined-release rollback.
Retain foundation objects, original migration/ledger evidence, all conversations,
messages and read states. Never drop tables, delete messages, renumber migrations,
repair history, turn on warnings or restore credential-bearing dispatch. Legacy
`send_message`/read RPCs continue to work with inbox off. No DB down migration exists.

## Evidence and remaining blockers

The ZIP holds actual local test results and source-preservation hashes. The isolated
tests execute PostgreSQL via PGlite using real canonical messaging bodies from
historical migrations 11 and 21, with synthetic Auth/account/listing/policy/identity
surfaces. There is no network, real Vault, Realtime or hosted database. Tests
temporarily enable inbox only inside disposable fixtures and finish with all five
flags false. That is not feature activation in either hosted environment.

Remaining blockers: exclusive release authority and enforceable protection;
fresh reviewed ledgers/trusted identity anchors; verified recovery/backup evidence;
native environment-specific automated security/performance/Realtime compatibility;
GitHub CI/integration on the exact requested base and compatible Web deployment.
No hosted deployment/read or manual testing was performed. Do not call this package
a certification that release approvals, credentials or hosted acceptance are ready.

Local pre-existing CI integration conflict: the unchanged `db-verification.test.mjs`
expects a `ratings-native-pg17` job absent from the unchanged local workflow (151/152
verifier tests pass in canonical checkout). This is outside this release's scope;
both files retain their task-start hashes. ChatGPT must reconcile that unrelated
integration state on the target branch without removing any gate. The new isolated
inbox tests, legacy 93-test contract and canonical baseline checks pass independently.
