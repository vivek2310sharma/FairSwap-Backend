# Moderation V2 B2 — Stored-byte immutability feasibility

**Status:** Experimental source candidate only. **Do not run this SQL on any hosted project or create an actual production migration from it yet.** Production remains at 55 migrations with V1 enabled and V2 disabled.

## Why this exists

Default-off V2 foundation is installed, but app-level `upsert: false` and RLS do not stop a compromised or mistaken privileged Storage caller from replacing or deleting an image that was moderated. The approved contract is `docs/moderation/MODERATION_V2_CONTRACT.md §3.2`.

Web work:

- [PR #178](https://github.com/vivek2310sharma/FairSwap-Web/pull/178): create-only normal seller uploads, collision-safe failure cleanup, sealed derivative URL parity for Web and native. Merged; Vercel Production READY.
- [PR #179](https://github.com/vivek2310sharma/FairSwap-Web/pull/179): defers unexpected/sealed keys from seller delete and orphan cleanup. CI green; unmerged pending trusted retirement design.
- [PR #180](https://github.com/vivek2310sharma/FairSwap-Web/pull/180): isolated local Storage API proof for the candidate `storage.objects` BEFORE UPDATE/DELETE trigger. It exercises `service_role`, physical byte hash, signed URL, create-only collision, legacy update/delete and move into the sealed namespace. **The local test is not vendor compatibility approval.**

## Storage guard approach

The candidate in `guard.candidate.sql` forbids changes or deletion to either media bucket when the *old* key's third segment is `v2`, and forbids an ordinary object being moved *into* that namespace. The guard is a database trigger, not RLS: `service_role` bypasses RLS, but ordinary SQL trigger execution applies to service_role Storage API writes in the disposable test.

Sealed key form: `<listing_uuid>/<media_uuid>/v2/<asset_version_uuid>/<sha256>/<variant>.<ext>`.

This proposal **does not** authenticate the sealer on creation, grant trusted retirement, validate contents against SHA-256, prevent privileged SQL DDL that disables the trigger, or make a signed URL authoritative for publication. Those are separate security boundaries.

## Mandatory promotion gates (all must pass)

1. Confirm with Supabase/Storage maintainers that a customer-created `storage.objects` row-level trigger remains supported across the specific hosted Storage version and schema upgrades. The Storage schema is provider-managed. Preserve all built-in triggers and system functions.
2. Prove **byte integrity after rejected mutations** under standard upload `upsert:true`, `update()`, `move()`, `remove()`, copy, S3 compatibility APIs, resumable/TUS finalize, concurrent writers and cancellation. Prove V1 uploads, signed URLs and legitimate deletion remain functional in the same stack.
3. Implement an independent credential boundary for *creating* sealed assets. Existing Web, iOS, Android and ordinary cleanup jobs must have no unapproved write/read/delete authority over sealed evidence. Registry RPC validates complete bundle provenance, digest/recipe, asset version and listing/revision under DB locks.
4. Implement **trusted retirement and DPDP deletion workflow**. The seller's listing-locked metadata transaction must withdraw public visibility and invalidate evidence before permanent removal; privacy deletion requests must not leave indefinite locked private objects. This candidate intentionally has no retirement bypass.
5. Review and prepare a new ordered forward migration with the pinned Supabase CLI only after gates 1–4. Require exact V2-off preflight; staging/PG17 test, release code hashes and postflight; no ad hoc hosted DDL.
6. Validate full B4 parity with Web, Android Studio and iOS/Xcode native flows, actual signed URL delivery and seller mutation races. Confirm image sealer runs on a trusted image-processing runtime; do not assume Sharp works in Deno Edge.
7. Only after sealer, evaluator, guarded finalizer, worker/provider privacy approval and monitoring are complete: separately authorize V2 shadow mode, then enforce mode with canary and rollback.

### Explicit NO-GO

- Do not merge experimental SQL as a production migration.
- Do not change `moderation_v2_enabled` / `moderation_v2_mode` or V1 settings.
- Do not deploy the large V2 worker PR #29 or Test-only SQL to Production.
- Do not store Production keys in GitHub, ChatGPT, or agent logs.

### FairSwap India outcome

This is needed to prevent a listing's photos from being replaced *after* an AI anti-fraud decision, a weakness that can undermine buyer trust even if payment-link and fake-courier detection are implemented.
