# Solo-owner governance and release attestation

This replaces the former two-administrator procedure. The sole governance owner is
`vivek2310sharma`. No second reviewer or independent administrator is fabricated.
Codex prepares this source and procedure only: no live GitHub setting, approval,
comment, collaborator, token, database or feature flag is changed by this task.

## Required GitHub configuration, outside this source-only task

- Preserve active repository ruleset `main-owner-only-updates`, ID `25821687`, on
  main only, with exactly deletion, non-fast-forward and update rules. Preserve its
  exact complete bypass list:
  `[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]`.
- Preserve active `protect-main`, ID `25352225`, on main, requiring PR creation with
  **zero mandatory approvals**, stale-review dismissal and every existing required
  CI context, including `backend-ci-success` and `chat-inbox-native-pg17`. It must
  have **no bypass actors**. Do not remove or rename existing checks. The full
  effective rules and rule parameters remain bound into the state fingerprint.
- Only `vivek2310sharma` may have the administrator repository role. Other known
  human collaborators may hold standard read, triage or write access to contribute
  branches/PRs. Maintainer, custom/unknown privileged roles, bots, ambiguous permission
  flags, duplicate identities or additional administrators block the audit.
- Both `FairSwapTest` and `FairSwapProd` must have exactly one required reviewer:
  the owner, as a User with the live owner ID. Set `prevent_self_review=false`,
  `can_admins_bypass=false`, `custom_branch_policies=true`,
  `protected_branches=false`, and exactly the branch policy `main` / `branch`.
  These are two separate approval gates, even though the same owner approves each.
- Keep the existing environment-only secrets `CHAT_DATABASE_PASSWORD` and
  `CHAT_RELEASE_AUDIT_TOKEN`. Both audit tokens remain fine-grained and read-only.
  The existing non-secret environment references are `CHAT_APPROVED_LEDGER_JSON`
  and `CHAT_RELEASE_ADMIN_ATTESTATION_JSON`; no new persistent variable is needed.

The update restriction plus the verified sole administrator makes the existing
administrator-role bypass usable only by the owner. Contributors can submit PRs but
cannot update/merge main. The owner reviews contributor PRs and merges them. Owner
PRs can merge without an independent approving review once all required CI passes.
PR creation and CI are enforced by the separate no-bypass `protect-main` ruleset;
the update exception cannot bypass them. This audit validates that configuration;
it does not itself intercept GitHub's merge endpoint or configure live rules.

The recognized rulesets must be active Repository/branch rulesets in this exact
repository with one `refs/heads/main` include, or `~DEFAULT_BRANCH` while the default
branch is main, no exclusions and no additional condition kinds. The owner-update
ruleset must contain exactly `deletion`, `non_fast_forward`, `update`, including in
the effective-main response. PR and CI rules must belong to `25352225`. Unrecognized
rulesets or changed scope/actor/type/mode fail closed. Every exact condition spelling,
parameter, version and configured CI context is also fingerprinted.

## Read-only verification and inventory

The runner fetches the complete collaborator inventory with
`affiliation=all&per_page=100`, validates user IDs, standard roles and all five
permission flags, and requires the owner to be the only administrator. Denied or
malformed metadata, a pagination-next link, duplicate identities or a full 100-entry
page whose completeness is not established block execution. The current bounded
implementation accepts only a complete single page with fewer than 100 entries;
it never treats a partial page as complete. An owner statement cannot override an
unverifiable inventory. The inventory is included in the protection snapshot and
rechecked after attestation verification.

Use only read access needed for Metadata, Contents, Environments, Secrets and Issues
(or PR conversation comments). The underlying owner identity must be allowed to
read the complete collaborator list. Never add Administration write permission to
an audit token. An unavailable read is a blocker. Actor, triggering actor, repository,
main ref and immutable source/bundle are checked by the workflow and runtime.
Only an owner-triggered `workflow_dispatch`, including an owner-triggered rerun of
an originally owner-triggered run, is accepted.

Read-only ruleset responses may omit `bypass_actors`. Omission proves nothing. The
owner's payload must explicitly state the exact owner-update actor list and the
empty `protect-main` list. If the API exposes either list, it must match exactly.
No fallback weakens CI, administrator inventory or environment approval checks.

## Owner attestation V2, separately for each environment

1. Finalize and review the exact immutable main commit and compute `bundleHash()`
   from that checkout. Capture/review the environment's exact approved ledger JSON
   under the existing ledger contract. Compute SHA-256 of its **raw UTF-8 bytes**.
   No credential or user/message data belongs in that metadata.
2. Use `audit_only=true`, `deploy=false`, approved SHA, bundle hash and the existing
   Test/Prod ledger-hash inputs. Both protected environment jobs receive their own
   `CHAT_APPROVED_LEDGER_JSON` and dispatch ledger digest, but no DB password. The
   candidate `UNAPPROVED_SNAPSHOT` contains only sanitized owner/state/ruleset/ledger
   metadata and hashes. Missing proof still fails the job; candidate output is not
   approval or verification. Test must pass before the Production audit proceeds.
3. The owner reviews the complete current GitHub ruleset state, collaborator
   inventory, environment controls, source/bundle and approved ledger. Prepare this
   payload, replacing every invalid example placeholder:

   ```json
   {
     "schema": 2,
     "repository": "vivek2310sharma/FairSwap-Backend",
     "environment": "FairSwapTest",
     "sourceCommit": "EXACT_40_HEX_COMMIT",
     "bundleSha256": "EXACT_64_HEX_BUNDLE",
     "ledgerSha256": "EXACT_64_HEX_RAW_LEDGER_DIGEST",
     "snapshotSha256": "EXACT_64_HEX_GITHUB_STATE_DIGEST",
     "observedAt": "UTC_ISO_OBSERVATION_TIME",
     "expiresAt": "UTC_ISO_TIME_WITHIN_24_HOURS",
     "owner": {"login": "vivek2310sharma", "id": 0},
     "reviewIssue": 60,
     "rulesets": [
       {"id": 25352225, "policySha256": "EXACT_VISIBLE_POLICY_HASH", "updatedAt": "EXACT_UPDATE_TIME", "bypassActors": []},
       {"id": 25821687, "policySha256": "EXACT_VISIBLE_POLICY_HASH", "updatedAt": "EXACT_UPDATE_TIME", "bypassActors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]}
     ]
   }
   ```

   This example is deliberately invalid and conveys no approval. Use the actual
   live owner ID, ascending ruleset IDs and UTC ISO timestamps ending in Z. The
   observation must follow all ruleset update times. Expiry is at most 24 hours.
4. Canonicalize with exported `canonicalJson(payload)` from
   `scripts/release/inbox-protection.mjs`: recursively sorted object keys, preserved
   arrays, compact JSON. The owner publishes a new unedited repository issue/PR
   conversation comment with exactly `CHAT_RELEASE_OWNER_ATTESTATION_V2`, one LF,
   then the canonical payload, with no trailing newline. This is a real owner
   statement, not a second-person review or a cryptographic signature. Codex does
   not publish it under this task.
5. Store the existing environment reference as an envelope with **only** `payload`
   and numeric `attestationCommentId`. No reviewer or approval-comment ID exists in
   V2. Legacy V1 evidence is rejected. The GET-only verifier reads the comment from
   the fixed repository endpoint, validates the owner login/ID/type/current admin
   permission, exact body, issue, no edits, time and all source/bundle/state/ledger
   bindings. It rechecks live state and expiry before accepting.
6. Obtain successful owner-approved Test and separately owner-approved Production
   audits. These audits make no claim about hosted DB state and do not deploy or
   activate anything. Any changed SHA, bundle, ledger, collaborator privilege,
   ruleset, environment control or expiry requires fresh owner evidence.

Deleting/editing the statement or removing the reference revokes acceptance. Do not
edit a statement in place to repair it: publish a new owner statement and replace
the reference. No live statement is fabricated in this archive.

## Release receipts, remaining boundaries and rollback

The actual deployment keeps all default-off authority gates, protected environments,
source verification, exact history guards and automated PG17/RLS/off-state postflight.
V2 receipts retain existing source/execution/bundle/history hashes and add the raw
approved-ledger hash, owner attestation hash and both owner actor identities. Before
any Production API/DB use, Production requires a successful same-run/attempt V2 Test
receipt matching the exact source, bundle, owner identities, five OFF flags and the
dispatch Test ledger digest. A failed/skipped Test, legacy receipt, changed ledger,
other actor or foreign run cannot authorize Production.

Live GitHub configuration and required checks, complete token visibility, owner
attestations, authority transfer and exact supplied-HEAD applicability remain
unverified until separately authorized operations provide evidence. Collaborator
inventory verifies repository users/roles; the existing privileged-writer and
integration authority cutover requirements remain in force. No owner statement can
replace missing API evidence or those release-authority requirements.

Separately authorized order: FairSwapTest -> automated verification -> FairSwapProd
-> separate inbox activation. Five Chat V2 DB flags stay OFF during rollout; Web
inbox remains OFF until separate activation. Roll back governance with Git revert.
For future activation rollback, Web OFF -> DB inbox OFF, retaining additive schema,
migration history and messages. No hosted/manual/exploratory testing is performed by
this source correction.
