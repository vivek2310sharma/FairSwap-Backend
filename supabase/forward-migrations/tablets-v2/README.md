# Tablets V2 India catalogue

Apply the single forward migration `20261104215253_tablets_v2_india_catalogue.sql` after the installed Tablets V1 foundation using a reviewed, ledger-matched bundle. The migration adds one ledger version and keeps the installed V1 activation state. Test precedes Production. The baseline and previously applied migrations retain their bytes.

The seed preserves all installed IDs. Normalized names and the per-brand Other flag have unique indexes. New catalogue rows carry legacy-compatible posting choices and use `Not specified` for unknown metadata. The validator and submit implementation retain their V1 signatures, owners and grants. The public wrappers, row-level policies, session/media lifecycle and phone/Accessories contracts keep their existing interfaces.

## Evidence files

- `catalogue-evidence.csv` covers the 282 source rows, including candidate decisions and unresolved evidence. Its approximate year is retained only for auditing.
- `catalogue-manifest.csv` lists each selectable named identity, including the six retained V1 rows, verified additions and aliases. Market labels distinguish India evidence from an import identity with unresolved India availability. A release year is supplied where sourced. Brand and family metadata identify the device. They do not certify its configuration or a seller's listing.
- `catalogue-brand-evidence.csv` records brand-level evidence separately. The reserved Other brand is already installed.

## Local verification

Run from Backend with the sibling Web dependencies installed.

```sh
node scripts/ci/test-tablets-v1.mjs ../FairSwap-Web --with-v2
node scripts/ci/test-tablets-v1.mjs ../FairSwap-Web --with-v2 --native-bin=/absolute/path/to/postgresql-17/bin
node scripts/ci/test-posting-v2.mjs ../FairSwap-Web --with-tablets-v2
node scripts/ci/test-accessories-v1.mjs
node scripts/verify-migration-manifest.mjs
```

The native mode starts a new PostgreSQL 17 cluster with a private Unix socket and checks concurrent V2 retries through separate connections. Both database modes use the real candidate migrations with fixture auth and storage helpers. Hosted verification needs the environment-specific release run.

Rollback uses a reviewed forward migration and preserves existing listing context and media. Coordinate Web rollback with the V2 buyer decoder if custom specs have already been stored.
