# Independent administrative attestation

This protocol supplies only bypass information hidden from read-only APIs. It never
substitutes for denied APIs, environment approvals, live effective-main rules,
required reviews/CI, main-only deployment restrictions or secret-name scope checks.
No database migration, secret change or flag change is required by this correction.

## Trust and least privilege

Each protected environment continues using the existing **non-secret reference**:
`CHAT_RELEASE_ADMIN_ATTESTATION_JSON`. This is an independently approved reference,
not a repository variable, workflow source assertion or token. Configure it through
the existing administrative approval process; this handoff creates no live evidence.
This policy correction introduces no new environment variable or attestation field.
Existing `CHAT_DATABASE_PASSWORD` and `CHAT_RELEASE_AUDIT_TOKEN` remain environment
secrets, with distinct Test and Production values. Never expose their values.

Keep both audit tokens fine-grained and read-only, restricted to this repository.
The GET endpoints require Metadata, Contents, Environments and Secrets read access,
plus Issues read (or Pull requests read for PR conversation comments). Grant no write
permission, including Administration write. If a required GET is denied, fix its
read scope or leave execution blocked; do not change the token to an administrative
write token. Administrator inspection happens with administrators' existing access,
outside these audit identities. GitHub explicitly documents that ruleset bypass
lists are hidden without write access: [rules API](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset).
Comment and current collaborator-role metadata are independently read via the
[issue comments API](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment)
and [permissions API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user).

## Procedure, separately for FairSwapTest and FairSwapProd

1. Finalize/review the correction and immutable release commit on `main` through the
   separately authorized GitHub process. Compute `bundleHash()` from that exact
   checkout. Source changes require a new bundle and new attestations. The local
   handoff cannot attest a remote commit that it does not possess.
2. Use the protected `audit_only=true`, `deploy=false` execution path with that SHA
   and bundle. Its candidate `UNAPPROVED_SNAPSHOT` result exposes only the snapshot
   hash and per-ruleset IDs, policy hashes and update times. Missing attestation is
   an expected **failure**, not a passed audit. Neither environment job receives a
   database password. Test must pass before the Production audit job can proceed.
3. An administrator independently inspects **every effective ruleset** listed in
   that snapshot using existing administrative settings/access. There must be
   exactly the two recognized repository rulesets below; unexpected or inherited
   effective rulesets block the audit. Confirm active enforcement, exact conditions/rules/version and
   the exact complete bypass list required by the pinned policy below. Also independently review
   main reviews/CI, environment reviewer identities, self-review prevention,
   administrator bypass disabled, main-only branch policy and environment-only
   secret names. An unavailable complete administrative view is a blocker. Do not
   infer empty bypass lists from omitted fields in a read-only response.
4. Prepare a payload with precisely these keys (replace all example metadata):

   ```json
   {
     "schema": 1,
     "repository": "vivek2310sharma/FairSwap-Backend",
     "environment": "FairSwapTest",
     "sourceCommit": "EXACT_40_HEX_WORKFLOW_COMMIT",
     "bundleSha256": "EXACT_64_HEX_BUNDLE_HASH",
     "snapshotSha256": "EXACT_64_HEX_CANDIDATE_SNAPSHOT_HASH",
     "observedAt": "UTC_TIME_AFTER_ADMINISTRATIVE_INSPECTION",
     "expiresAt": "UTC_TIME_WITHIN_24_HOURS_OF_OBSERVATION",
     "attestor": {"login": "ADMIN_LOGIN", "id": 0},
     "reviewer": {"login": "DIFFERENT_ADMIN_LOGIN", "id": 0},
     "reviewIssue": 60,
     "rulesets": [
       {"id": 25352225, "policySha256": "EXACT_PROTECT_MAIN_POLICY_HASH", "updatedAt": "EXACT_RULESET_UPDATE_TIME", "bypassActors": []},
       {"id": 25821687, "policySha256": "EXACT_OWNER_UPDATE_POLICY_HASH", "updatedAt": "EXACT_RULESET_UPDATE_TIME", "bypassActors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]}
     ]
   }
   ```

   The example is deliberately invalid and conveys no approval. Use actual numeric
   GitHub user/ruleset IDs, all rulesets in ascending ID order and UTC ISO timestamps
   ending in `Z`. Both named people must be distinct current repository administrators
   and human GitHub users. Observation must follow all bound ruleset update times.
   Validity is at most 24 hours, with no future observation or expired acceptance.
5. Generate canonical bytes with exported `canonicalJson(payload)` from
   `scripts/release/inbox-protection.mjs`: recursively sorted object keys, preserved
   array order, compact JSON. The attestor publishes a **new, unedited** conversation
   comment on the named repository issue/PR, with exactly this body and no trailing
   newline: `CHAT_RELEASE_ADMIN_ATTESTATION_V1`, one LF, then those canonical bytes.
   This is administrative evidence publication by the administrator; coding agents
   do not publish or approve it under this task.
6. The different administrator independently reviews those exact bytes and bypass
   observations. They publish a **new, unedited** comment on the same issue/PR with
   exactly `CHAT_RELEASE_ADMIN_APPROVAL_V1`, one LF, then `protectionHash(payload)`.
   The approval must follow the statement and observation. This digest binds the
   hidden-information claim to the exact release commit, bundle and visible policy.
   It can be issued after a merge, avoiding a circular commit hash or a dependence
   on PR review commit IDs that change under squash/merge commits.
7. Through the independent environment configuration process, store an envelope
   with exactly `payload`, `attestationCommentId`, `approvalCommentId` in that
   environment's `CHAT_RELEASE_ADMIN_ATTESTATION_JSON`. The IDs are numeric IDs of
   the two comments above, not arbitrary URLs. Store no credentials. The runner
   reconstructs fixed repository API URLs and verifies author IDs/logins, current
   administrator permissions, issue identity, exact bodies, no edits, timestamps,
   expiry, source/bundle binding and the complete live snapshot. It rechecks live
   protections after validating the comments. A visible list differing from the
   exact pinned policy, or any malformed list, vetoes an approved statement.
8. Repeat the protected audit-only run and obtain `status=verified` for Test then
   independently approved Production. Only sanitized hashes/status are returned.
   No migration, hosted database/Web check, activation or release authority follows
   from that result. The separate authorized deployment continues to require the
   original Test-to-Production same-run receipts, full automatic database postflight,
   existing messaging/RLS verification and all five DB flags plus Web inbox OFF.

## Revocation, changes and remaining requirements

Deleting or editing either evidence comment, removing an administrator, changing
the commit/bundle/protection snapshot/ruleset version or expiry blocks reuse. To
correct evidence, issue new comments and replace the protected environment reference;
do not edit a comment in place. Revoke by removing the environment reference or
deleting an evidence comment. All effective rulesets require explicit attestation
even if a response happens to expose `bypass_actors`. This is a
bounded administrative assertion, not cryptographic proof of hidden server state;
its trust rests on two administrators, protected environment approvals and the short
validity window. Settings can change after an audit; the actual release independently
reaudits immediately before database use and refuses stale evidence.

No live administrative evidence is fabricated in this archive. Availability of two
independent administrators, actual token scopes, protected environment configuration,
live audit-only execution and applicability at the supplied remote HEAD remain
unverified. This procedure does not ask for exploratory or owner database testing.

## Exact owner-update exception and automatic CI

The only recognized effective rulesets are repository-owned `protect-main`
(`25352225`) and `main-owner-only-updates` (`25821687`), active on branch targets in
this exact repository. Both must target only `main`: one include of
`refs/heads/main`, or `~DEFAULT_BRANCH` while the live repository default is `main`,
with no exclusions or additional condition kinds. The exact condition spelling,
parameters, full rules and update times remain bound to the policy/snapshot digest.
Changing any of them invalidates the previous signed evidence.

Only `25821687` may have bypass actors. It must contain **exactly** the three rule
types `deletion`, `non_fast_forward` and `update`, both in its policy and the live
effective-main rules. Its complete bypass list must contain exactly
`{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}`, with no
additional actors or fields. This is the user-reported existing RepositoryRole
exception, not a claim that actor 5 identifies an individual owner. It must be
independently observed and explicitly included in the administrator payload.
Omission from a read-only response is never proof of its contents.

All PR approval and required CI rules must belong to `25352225`, which must retain
zero bypass actors in both visible metadata (when supplied) and signed evidence.
Moving either rule type onto the owner-update ruleset, adding either there, changing
the exception's actor/type/mode, or introducing another ruleset is rejected. No live
ruleset is changed by this code. Existing token scopes and both independent
administrator approvals remain unchanged; source/bundle changes require fresh proof.

The existing `chat-inbox-native-pg17` PR-triggered job now executes both protected
release and read-only audit tests before its unchanged native database fixture.
There is no path filter, conditional skip, new check name or reduced permission gate.
Whether the live branch rules require this check is still audited from metadata;
this local task makes no GitHub administration changes.
