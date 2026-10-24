# India taxonomy candidate — release correction, 25 October 2026

Local source preparation only. No hosted migration, activation or release is authorized by this document. This directory is outside the immutable 58 migrations.

Both migration files intentionally omit top-level `BEGIN`/`COMMIT`. The Supabase migration runner owns one transaction around each complete file, including its migration-history write. Preserve `SET LOCAL lock_timeout='5s'`, `SET LOCAL statement_timeout='30s'` and the existing locks inside that transaction. Do not execute migration statements individually in autocommit mode or add nested transaction boundaries: failures must roll back the whole migration. Disposable database runners must provide the same outer transaction and roll it back on any error. ChatGPT will update the CI runner; no Actions configuration changes are included here. The separate operator script `deactivate.readwrite.sql` retains its own transaction and must not run inside the migration batch/wrapper.

`20261024213147_india_goods_taxonomy.sql` adds 15 Goods categories and two attributes per category, using the existing categories/attributes tables. Both `is_active` and `new_listing_enabled` start **false**, hiding the seeds even from older active-category clients. Existing category UUIDs, historical listing references, family contracts, RPC signatures, moderation states, RLS policies and grants are preserved. Client category/attribute DML remains denied. The new private trigger function has no client EXECUTE grant.

The database trigger runs **AFTER ROW INSERT/UPDATE**, so it validates the final `NEW` row after every BEFORE trigger on Test and Production. It does not depend on alphabetical trigger names, rewrite the row, or disable any existing lifecycle/moderation guard. This fixes premature rejection when INSERT forces a draft and closes missed validation when a material edit forces pending review. Errors roll back the entire statement and its transactional transition/queue writes. Category row share locks serialize eligibility checks with deactivation. No external worker dispatch behavior is changed.

Only string `item_type` and `brand` answers of at most 100 characters are accepted, including direct seller, staff and worker writes. Drafts can be incomplete; final review/publication states require a nonblank item type. Disabled or inactive categories cannot receive new assignments or be submitted/published. Existing drafts remain editable. Existing publication completeness, prohibited-item checks, moderation worker, staff authorization and release gates still apply.

The `india_goods_v1` marker on attribute validation rules selects the matching Web Zod contract. This is validation metadata in the existing attribute table, not another category store. The guard is installed with disabled seeds. Compatible Web must be deployed before the separately gated activation below; old/stale clients cannot bypass database validation after activation.

## Included and deferred

| Group | Changes |
| --- | --- |
| Fashion | Men, Women, Kids (clothing and footwear), Watches, Sunglasses & Accessories |
| Kids & Baby | Strollers & Prams; Cribs, Cots & Baby Furniture; Baby Gear & Accessories; Toys & Games; School Bags & Kids Essentials |
| Appliances | TVs & Video; Audio & Home Theatre; Power Backup & Solar; Other Home Appliances |
| Furniture & Home | Kitchenware & Utensils |
| Property | Web exposes the existing `PG & Co-living/Flatmates & Shared Rooms` contract separately from PG. No stored path changes. Godowns/warehouses have discovery labels only; commercial rental/sale contracts are missing. |
| Car seats | Unavailable. No database identity or enabled route is created. Requires verified recall/model identification, crash damage/missing-parts handling and authoritative publication denial before activation. A seller declaration alone is insufficient. |
| Other | Unavailable. No database identity or enabled route is created. Current title/description automation can approve clean text, and Admin lacks reclassification; do not route fallback listings into ordinary Goods. |
| Exempt EVs | Unavailable. No bicycle contract is changed or invented. Registered electric motorcycles/scooters retain the existing two-wheeler flow and its gates. |

Other requires a bounded category-specific item description, database-enforced `pending_review` and mandatory staff decision (including every worker finalizer), revision-safe AAL2-authorized reclassification with attribute validation and audit evidence, no seller category/status bypass, existing prohibited-item checks and preserved drafts. Reuse existing statuses; do not introduce a new status. Admin integration must follow the guarded page/action client pattern and backend authorization. No service-role fallback.

## EV classification research

The [Ministry notification G.S.R. 823(E), 6 November 2023](https://morth.gov.in/sites/default/files/notifications_document/9th%20GSR%20823(E)%20dated%206th%20November%202023%20HEV.pdf) describes multiple conditions verified and authorized by a Rule 126 testing agency, including motor power, speed, braking/reflectors, weight and pedal-assistance behavior. Speed alone is insufficient. Current applicability and subsequent amendments must be established for the actual vehicle before implementing an exemption classifier; no numeric exemption claim is shown to users.

The existing Web `two-wheeler/v1.json` includes `tw-electric-motorcycles` and `tw-electric-scooters`; it provides no exempt bicycle contract. `bicycles-sports` remains an unmapped legacy category, and existing saved edits must remain supported. Future exempt routing needs authenticated private certification evidence, backend validation and bicycle-style fields without mandatory RC; registered vehicles keep the two-wheeler contract. Do not accept a seller-supplied speed as proof.

## Future Business & Industrial taxonomy (inactive)

Proposed scope: Shop Counters & Display Units; Restaurant & Catering Equipment; Machinery & Workshop Equipment; Bulk Office Furniture; Shop Clearance Equipment. These are future design labels, not database seeds or visible Coming Soon cards. Review each against existing Furniture/Appliances categories, retain existing identities where equivalent, and define equipment-specific condition, power, capacity, ownership and safe-removal fields before implementation. Do not add regulated/prohibited goods through a clearance label.

## Release and verification

Owner/ChatGPT deployment order:

1. **Staging database:** apply only the disabled seed `20261024213147_india_goods_taxonomy.sql` to FairSwapTest `wpppxlnbzqynvhpeuavd`.
2. **Staging application:** deploy the compatible reviewed Web source with `india_goods_v1` Zod validation and eligibility filtering. Record the actual deployed Web commit and automated deployment/compatibility evidence. Do not ask the owner for manual predeployment testing.
3. **Staging activation:** separately apply `activation/20261024221855_activate_india_goods_taxonomy.sql` with that environment's release attestations. Save the receipt and execute automated postactivation checks.
4. **Production database:** apply only the disabled seed to FairSwapProd `kriuhwppxgxsyyrbjsau` in its isolated ledger-matched workspace.
5. **Production application:** deploy the focused compatible Web release; record its actual deployed commit/evidence separately from staging.
6. **Production activation:** separately apply the activation migration with the Production attestations and record postactivation evidence.

**Never put seed and activation in one automatic migration batch.** The activation file is intentionally in a separate subdirectory. It refuses missing/malformed release attestations, unknown project references, partially enabled/missing seeds, incompatible attributes, or missing/disabled/BEFORE-only validation. It updates the original 15 UUIDs atomically, verifies all 15 became eligible and clears its session acknowledgements. Unsupported categories and family release gates are untouched.

In the **same operator database session** that runs the activation file, supply these nonsecret acknowledgements using the actual compatible deployed Web commit (40 lowercase hexadecimal characters):

```sql
select pg_catalog.set_config('app.india_taxonomy_target_project', '<target project ref above>', false);
select pg_catalog.set_config('app.india_taxonomy_verified_web_release', '<actual compatible deployed Web commit>', false);
```

These are operator attestations, not proof the SQL can independently obtain from Vercel, not authorization for application users, and not environment variables. The approved release runner must verify its connection/project and the actual deployed artifact before setting them, execute the complete activation file inside its runner-managed transaction on that connection, and atomically record the migration ledger/receipt. The settings may be supplied before or within that outer transaction, but never on a different connection. On failure the runner rolls back activation and any transactional acknowledgement clearing; reverify attestations before retrying. Client grants/RLS still prevent clients from activating categories even if they supply these settings. **New staging/production environment variables: None.** Backend has no standing staging branch; existing source/release ownership stays unchanged. Admin requires no application change for ordinary Goods.

Use an isolated, ledger-matched release workspace and the existing release authority/backup process, never the raw 58-file migration directory. These are unapplied candidate revisions: verify neither candidate version has already been recorded before admission; if an earlier candidate was applied, stop and prepare a separately versioned forward correction rather than rewriting/replaying ledger history. The seed aborts on matching names/slugs rather than duplicating or overwriting an existing identity. Full isolated Supabase/RLS/worker compatibility rehearsal remains required release evidence; source-function fixtures do not replace it. Hosted operation/CI reruns remain ChatGPT-owned.

Cross-repository automated candidate checks from FairSwap-Web:

```text
corepack pnpm vitest run tests/unit/india-taxonomy.test.ts tests/security/india-taxonomy-migration.test.ts tests/unit/post-ad-selector.test.tsx tests/unit/post-ad-goods-server.test.ts
```

The SQL rehearsal reads this sibling Backend candidate and actual trusted-field/material-edit/family guard source functions. It supplies test-managed transactions for both migrations, checks timeout scope and injects failures after the complete seed/activation body to prove DDL/data/UUID/flag rollback. It also exercises Test and Production foundation fixtures, late BEFORE-trigger rewrites, direct writes, privileged publication, disabled assignment, activation prerequisites and rollback preservation. Fixture staff/worker roles demonstrate trigger enforcement with privileged writes; they do not certify live staff AAL2/RPC authorization. The user-reported failure in Web Actions run `40137431482` motivates the regression; that run was not retrieved or rerun here. An isolated CI job must check out both reviewed sources. ChatGPT owns any Actions changes/reruns, including transaction-safe runner execution; no CI configuration was changed here.

After deployment, the owner should inspect ordinary production behavior/telemetry: enabled Goods choices reflect database eligibility; Hindi/English aliases find the intended entries; old drafts still open; existing Property/vehicle gates remain unchanged; unsupported choices remain unavailable; UPI and property fraud advice remains visible; no publication/validation failures increase. These are postdeployment checks, not a predeployment testing request.

Rollback before activation: leave the seed hidden/disabled and restore the prior Web artifact if needed. Rollback after activation: the approved operator runs `deactivate.readwrite.sql` in the affected environment to set both flags false for only the 15 slugs. Use existing authorized moderation to pause/quarantine affected pending/public listings where needed; retain compatible edit handling while any such work remains, then restore the retained same-environment Web artifact. Deactivation does not delete or rewrite listings, attributes, IDs, drafts or guards, and prevents staff/worker republication. Existing draft edits still work through the saved-category context. Record rollback evidence; never disable guards, delete identities or down-migrate history. Reactivation is a fresh explicit release decision; replaying the already-recorded activation migration is not a ledger operation.
