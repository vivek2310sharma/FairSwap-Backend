# Production-hidden category foundation — APPLIED AND VERIFIED

**Live Production (verified 18 October 2026):** FairSwapProd `kriuhwppxgxsyyrbjsau`, PostgreSQL 17.6, **52 applied migrations** (**45 existing + 7 approved forward migrations**). Cars, Two-Wheelers and Property have database foundations but remain **disabled** for customers. Goods moderation is unchanged.

**Canonical release evidence:** [Production deployment receipt](production-deployment-20261018.json) · [Seven exact pinned forward versions](forward-migration-plan.json) · [Historical preparation manifest](manifest.json) · [Read-only postflight](postflight.readonly.sql).

## What was applied

The operator ran Supabase CLI **2.117.0** against the linked FairSwapProd project with `db push --linked --skip-vault`, from an **isolated workspace** containing exactly the 45 Production-history files and the seven pinned forward files. The seven source SQL bodies were copied byte-for-byte and preserved the SHA-256 pins; the CLI-issued forward names and their source mappings are recorded in `forward-migration-plan.json`.

- Production migration ledger: **45 → 52**, matching the exact 52-version list in the receipt; no pending release migrations were reported.
- Checked-in read-only postflight: **PASS**, independently rerun via read-only Supabase access after the operator's release.
- RLS: **47/47** public base tables enabled; all three new category-context tables protected and not readable by `anon`.
- Publication: three listing guards enabled; zero experimental categories active; zero new experimental contract assignments; zero active experimental listings.
- Goods: moderation automation and enqueue trigger enabled; finalizer body MD5 `118d04445fdd9139d90decd2048945f1`; execution privileges preserved.
- CLI operator reported no seeds, roles, Vault changes, retries or migration history repairs. No website or mobile app was deployed.
- Prior isolated PG17.6 rehearsal passed **268** Goods/security pgTAP assertions ([run 39069138056](https://github.com/vivek2310sharma/FairSwap-Backend/actions/runs/39069138056)). That rehearsal is not proof of live customer/worker deliveries.

## Why the manifest still says 45 and PREPARATION_ONLY

The existing `manifest.json.productionBaseline` records the **historical pre-release** 45-version state. Its original preparation status, candidate hashes, exclusion list and false `releaseGates` are **intentionally preserved** as immutable preparation evidence (and to preserve the existing static verifier's invariants). They must not be interpreted as the *current* Production deployment state.

The **current deployed state as of 18 October 2026** is instead recorded in `manifest.json.productionDeploymentRecord` and `production-deployment-20261018.json`. The independent 52-version ledger observation and exact version-to-source mapping are preserved there. Backup/restore was not independently verified; the release relied on owner risk acceptance, not a verified restore.

## Important: main's migration directory is NOT a Production deploy workspace

`supabase/migrations/` remains the **58 original, checksum-pinned, multi-environment source files**. It includes historical Test-only category activations, plus the original versions of seven SQL bodies that Production applied under **different, forward-only versions**.

**Never run `supabase db push` directly from this repository's raw `supabase/migrations/` directory against FairSwapProd.** That would present a different migration history and could propose Test-only steps. For any future Production schema release, construct a fresh isolated **52-version Production baseline** using the exact 45 original Production migrations and seven pinned forward names and unchanged SQL bodies in the forward plan; first compare that baseline with the live ledger and then add only separately approved forward migrations. No Test-only activation is implied by this record.

The original SQL sources, PostgreSQL routines, preflight and postflight SQL were not changed by the GitHub record update.

## Scope and status

This documents the completed **hidden database foundation only**, not public submission, listing publication, feature activation, a future release permission, or transfer of the Backend/Web deployment ownership boundary. The draft rehearsal PR #8 was preparation-only; the actual release was performed separately by the explicitly authorized CLI operator.
