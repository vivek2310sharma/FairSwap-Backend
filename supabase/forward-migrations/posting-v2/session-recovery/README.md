# Posting V2.1.2 lifecycle and automatic rotation

2 November 2026. Owner-approved automatic-rotation amendment included. Canonical forward candidate, NOT deployed. Supabase CLI 2.117.0 generated `20261101234604_posting_v212_session_recovery.sql` locally at UTC 1 November. This still-unapplied candidate was extended; no previously applied migration or original foundation/activation was edited. The root 58-file immutable manifest remains unchanged.

## Reliable eligibility, without guessing about local drafts

No-photo does not mean no meaningful draft. The additive `draft_protected boolean not null default true` protects ALL existing/unknown sessions and ordinary new upload sessions. `empty_request_id` plus a unique owner/request index identifies a new, server-certified empty allocation. Neither column is client-writable; existing owner RLS/SELECT and revoked table mutation grants remain.

- `create_empty(request_nonce, operation, null)` through the existing RPC mints a fresh server session UUID, never certifies a supplied session/local draft UUID. The nonce is only an owner-scoped idempotency key. A repeated nonce returns the same session and cannot downgrade protection. Only this fresh insertion starts `draft_protected=false`.
- A client using that optional protocol MUST complete `claim_draft` before associating meaningful local data or offline autosave with the returned server ID. Do not publish an unclaimed empty ID into a recoverable local draft record. `create`, `read`, `reserve`, `remove` and `prepare` also permanently protect the session before work. No operation clears protection on an existing row, and elapsed time/lease expiry never proves absence of local data.
- The current Web upload path already contains selected retry blobs before it allocates, so it uses protected `create`, NOT the optional empty-allocation protocol. Entirely local unallocated UUIDs cannot be rotation victims. Old Web recovery/create/read also protects before work. Existing historical no-photo sessions stay protected because their local contents are unknown; do not bulk certify them through SQL or a heuristic.

Automatic eligibility requires `owner_id=auth.uid()`, open/unexpired state, `draft_protected=false`, a server empty-allocation key, and NO staged-media row of ANY state. This protects ready photos, removed history and active/failed upload leases independently of metadata. Finalizing/submitted sessions are never selected.

## Atomic allocation and compatible operations

The public invoker signature `posting_v2_session(session_id uuid, operation text, media_id uuid default null)` and explicit authenticated grants remain. Privileged logic remains private SECURITY DEFINER with empty search path. Actor/account/current-policy checks remain; no category activation, moderation/finalizer, Storage policy, extra table, new environment variable or workflow changes.

`create` and `create_empty` retain the five-active-session check under the original seller advisory lock (`hashtextextended(owner,2)`). Existing owned IDs retry without rotation. At capacity, select the oldest eligible row by `(created_at,id) FOR UPDATE`, mark it expired and insert the replacement in the SAME RPC transaction. A collision or failed insertion cannot partially retire the victim. Draft claims, read/create, explicit release and allocation use the seller lock; all reserve/prepare/completion/finalization paths share the session row lock. A reserve protects before any Storage write. Claim-before-rotation excludes the row; rotation-before-claim fails expiry instead of accepting new local work.

If none is certifiably safe, raise `PT429 / UPLOAD_SESSION_LIMIT`; do not choose an unknown draft. `list_recovery` is read-only, actor/account/policy guarded and bounded to five owned active records: `{limit:5,sessions:[{id,state,created_at,expires_at,draft_protected,can_rotate,can_abandon}]}`. No other-owner data, draft contents or media URLs. Web renders actionable recovery/selection. A seller may explicitly confirm `abandon_empty` for an owned no-photo-history session they no longer need, with a cross-device/local-draft warning; any media history or finalizing/submitted state blocks it. Saved local fields and real media are not silently deleted.

Stable errors: `PT410 / UPLOAD_SESSION_EXPIRED`, `PT409 / UPLOAD_SESSION_PROTECTED` and `42501 / UPLOAD_SESSION_UNAVAILABLE`. Web translates only allowlisted constants/known legacy messages, never SQL details. Existing create/read/reserve/remove/prepare callers keep their arguments/result envelope; metadata fields and operations are additive. Direct client writes to the protection columns remain revoked.

## Cleanup and preservation

Retirement/explicit release creates an expired cleanup tombstone, with no immediate row/object deletion. The unchanged service-only `posting_v2_cleanup`/operator worker can claim repeatedly and acknowledge repeatedly without touching the replacement or committed listing media. A rotation victim has no asset inventory: trusted storage writes require a prior protected reservation. Expired/submitted IDs are never reopened by ordinary retries. The usual cleanup lifetime bounds tombstone/request-key retention; deleting a fully cleaned blank may later permit a fresh empty allocation under an old nonce, but never resurrection of its old session ID or meaningful/media data.

## Independent Test-first release

1. ChatGPT independently reviews both repository patches/hashes and preserves unrelated work. No Git command, hosted metadata query or deployment occurred; branch/remote/hosted ledger parity is UNVERIFIED.
2. Reconstruct each target's authentic ledger independently. Verify Posting V2 foundation/signature/grants and expected readiness. Stop on unexpected versions/bodies or missing dependencies. Do not apply raw 58-file source, reapply foundation/activation, or edit ledger entries.
3. With separate authorization, install ONLY this candidate in the ledger-matched FairSwapTest workspace. Backend uses existing main/release processes, not a new staging branch. No flag or environment change is introduced.
4. Compatible Web follows existing CI → Staging/Test. Run the commands below alongside existing CI (this standalone script is not claimed to be automatically wired into workflows). Authorized automated authenticated hosted acceptance must cover five protected/unknown sessions, certified sixth rotation/oldest selection, simultaneous tabs/connections, ownership, claim-versus-rotation, expiry, upload/media preservation, cleanup and submission/moderation. Preserve Test notification isolation.
5. Authenticated hosted Test acceptance and independent review block Production. Only then selectively deliver Backend migration and Web to FairSwapProd, preserving environment-specific ledgers/category gates/Test-only differences, and run automated postflight. No manual/exploratory or owner predeployment testing is requested. Owner Production availability checks use automated authenticated journey/health/error evidence.

## Local verification

```sh
node scripts/ci/test-posting-v2.mjs '../FairSwap-Web'
corepack pnpm verify:migrations
corepack pnpm typecheck
```

The disposable script applies real foundation/candidate migrations in a fresh PGlite database and preserves all original 30 contract/media/moderation/RLS checks. Added cases cover legacy backfill, protection grants, safe empty minting, all-work-protected responses, sixth/oldest rotation, rollback, owner isolation, concurrent driver requests, claims, media history and retry-safe cleanup. Exact final counts/commands/logs are in the ZIP. Auth/storage/status helpers are explicit fixtures. PGlite serializes concurrent driver calls: native PG17 parallel-connection lock races, full Supabase/pgTAP and authenticated hosted acceptance are NOT RUN and must not be inferred from fixture success.

Web checks include production source build with real fonts/configuration, typecheck/lint, focused unit tests and isolated real-component browser tests. Browser APIs are synthetic/intercepted; native DB credentials, environment files and real user data are never read. No dependencies or CI workflows changed.

## Rollback

Restore/revert Web first if required, retaining data and the additive metadata columns. V2.1.1 rollback reintroduces eager allocation. A Backend rollback must be a NEW reviewed forward-fix restoring a compatible private function while retaining protection metadata, owned/media/submitted sessions, RLS and moderation. Never edit an applied file, rewind history, clear protection on meaningful/unknown drafts or resurrect retired IDs. No bulk cleanup or media rollback is part of this candidate.
