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


## Read-only hosted compatibility observation (2026-10-21)

A privileged **read-only** query on FairSwapProd reported:

- Project still has 55 applied migrations; V1 on and V2 off/disabled.
- `storage.objects` is owned by `supabase_storage_admin`, not `postgres`.
- In the connected `postgres` query session, `has_table_privilege(..., 'TRIGGER')` returned true despite the ownership difference.
- Two non-system Storage triggers already exist; do not drop or replace them.

`preflight.readonly.sql` reproduces the relevant catalog/settings checks from the **actual intended operator connection**. It runs inside an explicitly READ ONLY transaction.

**Critical:** grant visibility alone does not prove that a custom Storage trigger is a supported hosted feature or that it protects physical object bytes across S3/TUS/other protocols. It grants no permission to run `guard.candidate.sql`; the trusted retirement and re-publication design is still incomplete. No Production DDL was executed in this observation.


## CTO safety decision — 2026-10-21 (PRODUCTION TRIGGER NO-GO)

Supabase's official [Storage Schema guidance](https://supabase.com/docs/guides/storage/schema/design) says the managed `storage` schema should be treated as read-only, warns against alterations that may conflict with future updates and cause downtime, and requires object operations through Storage APIs. A custom trigger on `storage.objects` is an alteration to this provider-managed schema.

**Decision:** the local trigger experiment proves feasibility in one disposable version but **does not prove vendor support**. Do not promote or execute `guard.candidate.sql` as a hosted migration. A hosted `postgres` TRIGGER grant is not vendor compatibility approval. The source remains in `releases/experimental/` strictly for research.

### Preferred supported isolation path (requires infrastructure approval and integration)

- Use an **independently credentialed Storage security boundary**, preferably a dedicated, India-region Supabase project for V2 sealed objects (or a separately approved immutable object store). Ordinary FairSwapProd Web, Admin, native APIs and V2 provider workers must **not possess** its service-role or S3 full-access credentials.
- The sealer runs in a separate trusted Node runtime and receives a short-lived, independently issued restricted Storage identity that can INSERT/read in dedicated sealed buckets but cannot UPDATE/DELETE/move. Use official Storage RLS/custom-role policies, *not* SQL mutations of Storage metadata. Supabase [Custom Roles](https://supabase.com/docs/guides/storage/schema/custom-roles) and [S3 Authentication](https://supabase.com/docs/guides/storage/s3/authentication) document the relevant mechanisms and the danger of full-access keys bypassing RLS.
- Publishing SQL stays in FairSwapProd and accepts registration only from an independently credentialed sealer principal after all five create-only uploads/readback hashes and a listing-locked complete manifest check. A prepared-only JS object or caller-provided JSON is never sufficient.
- The provider worker gets at most read-only canonical-image access through a private gateway; user-visible Web/Android/iOS routes keep their JSON/redirect shape. Do not expose secondary-project secrets in Web/clients.
- Separately privileged retirement reconciles private evidence only AFTER atomic visibility withdrawal and evidence invalidation under the parent listing lock, with India DPDP erasure/retention review. Never give sealer delete/overwrite authority.
- Test that ordinary shared `service_role` credentials cannot mutate the isolated project, that the constrained sealer identity cannot upsert/update/delete/move via supported REST/S3/TUS channels, and that legacy V1 upload/deletion still work.

**Stop:** do not provision a paid project, generate roots/JWT signing keys, alter hosted Storage policies, or apply Production migrations solely based on this ADR. Obtain a concrete environment, India region, cost/identity confirmation and adversarial hosted non-Production proof first.
