# India taxonomy candidate — 24 October 2026

Local source preparation only. No hosted migration, activation or release is authorized by this document. This directory is outside the immutable 58 migrations.

`20261024213147_india_goods_taxonomy.sql` adds 15 Goods categories and two attributes per category, using the existing categories/attributes tables. Existing category UUIDs, historical listing references, family contracts, RPC signatures, moderation states, RLS policies and grants are preserved. Client category/attribute DML remains denied. The new private trigger function has no client EXECUTE grant.

The database trigger validates new-category answers on every listing INSERT/UPDATE, including privileged worker and staff writes. Only string `item_type` and `brand` answers of at most 100 characters are accepted. Drafts can be incomplete; review/publication requires a nonblank item type. Disabled or inactive categories cannot receive new assignments or be submitted/published. Existing drafts remain editable. Existing publication completeness, prohibited-item checks, moderation worker, staff authorization and release gates still apply.

The `india_goods_v1` marker on attribute validation rules selects the matching Web Zod contract. This is validation metadata in the existing attribute table, not another category store. Web validation is complementary; database validation is effective immediately upon migration, including requests from older clients.

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

Owner/ChatGPT deployment order: staging database (FairSwapTest `wpppxlnbzqynvhpeuavd`) → staging applications → production database (FairSwapProd `kriuhwppxgxsyyrbjsau`) → production applications. Backend has no standing staging branch; Web/Admin use staging integration and focused main releases. New environment variables: **None** in either environment. Existing family gates stay unchanged.

Use an isolated, ledger-matched release workspace and the existing release authority/backup process, never the raw 58-file migration directory. The migration aborts on matching names/slugs rather than silently duplicating or overwriting an existing identity; reconcile equivalent pre-existing categories before applying. Full Supabase/RLS/worker compatibility rehearsal remains required release evidence; the in-memory fixture test does not replace it. No owner manual testing before deployment is requested.

Cross-repository automated candidate checks from FairSwap-Web:

```text
corepack pnpm vitest run tests/unit/india-taxonomy.test.ts tests/security/india-taxonomy-migration.test.ts tests/unit/post-ad-selector.test.tsx tests/unit/post-ad-goods-server.test.ts
```

The SQL rehearsal reads this sibling Backend migration; an isolated CI job must check out both reviewed sources. ChatGPT owns any Actions change needed to add that command; no CI configuration was changed here.

After deployment, the owner should inspect ordinary production behavior/telemetry: enabled Goods choices reflect database eligibility; Hindi/English aliases find the intended entries; old drafts still open; existing Property/vehicle gates remain unchanged; unsupported choices remain unavailable; UPI and property fraud advice remains visible; no publication/validation failures increase. These are postdeployment checks, not a predeployment testing request.

Rollback: disable new assignments for the 15 added slugs, return affected pending/public listings to an existing nonpublic state through authorized moderation, and restore the prior Web artifact; retain all category IDs, saved drafts and the validation trigger. Do not delete categories or replay/down-migrate history.
