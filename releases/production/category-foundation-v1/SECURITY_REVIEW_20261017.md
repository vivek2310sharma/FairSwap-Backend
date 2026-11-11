# FairSwapProd hidden-category foundation — security review checkpoint
**State: TECHNICAL TRIAGE COMPLETE; SECURITY APPROVAL NOT GRANTED.**  
Review date: 2026-10-17. Target: FairSwapProd `kriuhwppxgxsyyrbjsau`, PostgreSQL 17.6, **45 applied migrations** at the time of inspection.  
Release source: `releases/production/category-foundation-v1/manifest.json` on Backend main. This document is review evidence, **not** a migration or an authorization.

## Reviewed scope
Seven approved, SHA-256-pinned source migrations create **hidden, inactive** Two-Wheeler, Car and Property draft foundations:
1. Two-wheeler draft tables, catalogues, RLS, context/guard triggers and owner-bound invoker draft RPC.
2. Two-wheeler bounded lookup and unresolved/reference corrections.
3. Car draft tables, catalogues, RLS, context/guard triggers and invoker draft/lookup RPCs.
4. Property-rental draft tables, RLS, contract validation, owner-bound invoker RPC and a scoped corrective lock.

**NO new publication, activation or Test-specific submission migrations are in the seven-file allowlist.** New contract-version `new_assignment_enabled` defaults false; categories are inserted inactive with new-listing creation disabled. Vehicle/Car/Property listing triggers reject transitions to public review/publication in this milestone. All three private listing-context tables have RLS and restrictive grants, with owner-draft/policy-status restrictions. Catalog lookup functions are authenticated and bounded. Draft save RPCs use `SECURITY INVOKER` and authenticate the caller. Trigger/internal `SECURITY DEFINER` helpers are located in the unexposed `app_security` schema with explicit SQL grant revocations. The isolated PG17 migration rehearsal passed a **45→52** schema-only replay, postflight, nine Goods regression suites and **268 assertions**, including Goods finalizer-body preservation.

These points are source-based and CI-derived evidence of **intent and schema compatibility**; they do not prove every fraudulent input or authenticated API interaction has been adversarially tested with Production data.

## Existing Production security-advisor baseline — not waived

| Finding | Observation | Required disposition |
| --- | --- | --- |
| Anon-executable public `SECURITY DEFINER` functions | 15 advisories; catalog review finds **14 trigger/event-trigger returning routines** plus `public.is_listing_publicly_visible(uuid)` boolean wrapper. | Confirm the helper returns only the expected boolean; review direct EXECUTE grants for trigger functions and external RPC exposure. Trigger return type makes them unsuitable as ordinary SQL calls but **does not** constitute a blanket security waiver. |
| Authenticated-executable public `SECURITY DEFINER` functions | 19 advisories; **5 ordinary callable routines** plus 14 trigger/event-trigger returning routines. Callable routines: `get_my_reports()`, `get_seller_listing_location_private(uuid)`, `get_staff_listing_location_private(uuid)`, `has_current_policy_acceptance()`, `is_listing_publicly_visible(uuid)`. | Independently verify auth.uid owner scoping, reporter-only rows, active staff AAL2, and the visibility helper semantics. Do not revoke intended app RPCs without a compatible client migration. |
| Mutable function search path | `public.generate_postal_source_record_key`. | Separately review invocation context and pin `search_path` in a backwards-compatible hardening migration, with regression evidence. |
| `pg_net` extension in `public` | One warning. | Review supported extension relocation and worker/runtime dependencies before any change; avoid moving blindly. |
| Leaked-password protection disabled | One Supabase Auth warning. | Owner/Auth administrator review; protect with appropriate Auth configuration, separate from category SQL. |
| RLS enabled with no policy | 3 INFO notices: `app_system_settings`, `listing_moderation_requests`, `listing_moderation_results`. | Verify they are intentionally deny-all to client roles while internal service operations continue to work. Do not add permissive policies merely to clear the linter. |

At inspection **29/29 public base tables had RLS enabled**. RLS on its own does not grant API privileges and is not a complete vulnerability scan. New context and reference tables must also have their expected RLS and grants after migration.

Official guidance:
- https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
- https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable
- https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable
- https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public
- https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## Gates before an authorized Production migration

- [x] Verify source allowlist and historical SQL hashes; exclude Test activation, policy and finalizer changes.
- [x] Run exact isolated PG17.6 reconstructed 45→52 rehearsal with private context RLS/ACL, guard, publication-denial and Goods regression postflight; **not** a restored live snapshot.
- [ ] Pin **final** reviewed forward migration filenames and hashes; replay the exact pinned filenames in the guarded CI.
- [ ] Independent security owner dispositions for the existing WARNs above and a focused check that new category RPC/table grants match the release's hidden state.
- [ ] Review authenticated category draft abuse/fraud cases (UPI advance-payment scams, fake courier/army claims, forged buyer payment links), and avoid any premature public listing/notification paths.
- [ ] Explicit Production release-owner approval for the exact 7-version plan, operational risk and cutover instructions.
- [ ] Production backup/restore or PITR evidence — **DEFERRED by owner, UNVERIFIED, NOT implicitly waived by a green CI**.

Release manifest `status` remains `PREPARATION_ONLY_NOT_APPROVED_FOR_EXECUTION`, all approval gates remain `false`. Do not merge any PR as a substitute for database release approval. Do not deploy SQL, change Vercel env vars, activate categories, or assume recovery is available without separate explicit permission.

## Why this is worth doing

Cars, two-wheelers and rental property are high-fraud-value Indian categories. Owner-scoped immutable category/context contracts and strict draft-only publication locks lay a safer foundation than an uncontrolled classifieds launch. They support FairSwap's trust-and-safety differentiation from OLX India, but fraud-related product controls and live moderation/appeals must still be validated before sellers can publish.
