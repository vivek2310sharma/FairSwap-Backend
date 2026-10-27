# Execution plan and decision

1. Capture local HEAD, existing dirty/untracked hashes and original PR #58 bytes;
   verify requested base through read-only PR metadata. Do not synchronize Git.
2. Reuse the exact foundation/version, rather than splitting shared flag/RPC objects.
   Package it in an isolated candidate directory. Inert safety objects remain off;
   no Phase1B migration, worker, scheduler, net ACL change or credential is required.
3. Prepare standalone per-environment psql entry points and a pure offline renderer.
   Require a recent reviewed ledger digest snapshot; check trusted environment URL
   anchors, account/messaging dependencies, owner role and all five flags off. Apply
   body plus ledger record atomically, with replay verification and drift rejection.
4. Add isolated PGlite/PostgreSQL checks using canonical messaging/policy function
   bodies; test permissions, grouping/pages/counts, read cursors, send/retry/block
   compatibility, inactive safety and release guards for both project identities.
5. Run existing applicable integrity/security verifiers unchanged. Preserve every
   initial file. Package only additive source, diff, hashes, exact requested base,
   actual local HEAD, automated results and unresolved release-authority gates.

This plan covers local preparation and automated disposable tests only. It grants
no release approval, GitHub mutation, hosted write or feature activation. ChatGPT
integrates into release/chat-v2-inbox-only, then coordinates protected Test before
Production. Rollback disables Web/database inbox while retaining additive objects
and messages; other flags remain off. No consumer repository is edited.
