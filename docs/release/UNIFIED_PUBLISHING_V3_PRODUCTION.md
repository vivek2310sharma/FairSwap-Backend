# Unified Publishing V3 disabled Production release

The package starts at Backend `d9cbdf079c83c34b7407ed36ab90a01072f825a9`.
It installs an additive identity prerequisite and the seven reviewed V3 SQL
files. The prerequisite uses the existing active-account and verified-badge
data, including expiration and revocation. It installs the listing, listing
media, posting session and staged media hooks with
`identity_verification_required=false`. It installs no verification provider
or diagnostics. The migrations preserve the existing seller function. The
property migration wraps only its item-terms checks and requires exactly one
matching block. All existing categories and public/storage RLS policies are
compared before and after each migration.

## Deployment

1. Validate the exact Backend commit through the existing push CI. Use the
   existing reusable Supabase release workflow in the reviewed release window
   with a verified Production backup. The verify job runs native
   PostgreSQL and moderation regressions, then checks the reviewed manifest
   and Test receipts. The seven Test receipts come from runs `44549355860`,
   `44550690764`, `44554475736` and `44567714896`. The last run applied four
   migrations after the first three. The release leaves those ledger entries
   in place and uses the recorded Test statement digests as Production pins.
2. Dispatch from trusted Backend `main` with the following inputs.

   | Input | Value |
   |---|---|
   | `candidate` | `v3-production-disabled-batch` |
   | `target` | `production` |
   | `approved_sha` | Reviewed 40-character Backend main SHA |
   | `expected_candidate_sha256` | `bebcdecc9e2ec72ece06f2c05b5ee12c09183c15bcf9f47a03450ed6bc0461ae` |

   The digest is for `MIGRATIONS.sha256` in the V3 release directory. The job
   uses the existing protected `FairSwapProd` environment,
   `FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN`, `CHAT_DATABASE_PASSWORD`,
   `CHAT_DB_SSL_ROOT_CERT_PEM` and `CHAT_DB_POOLER_HOST`. Each step derives
   its migration workspace from the target’s own history, dry-runs exactly
   one named candidate and checks the old ledger rows and installed SQL
   after applying. A diagnostic, unexpected newer row, existing V3 row or
   disabled-state mismatch stops the batch. Production requires an initial
   state with zero V3 migrations.
3. Require successful automated postflight and all eight Production receipt
   hashes. The last receipt must show `disabledContractCount: 58`,
   `identityEnforcement: off`, and equality of the Test and Production
   statement digests. After the Backend postflight, deploy the focused Web
   port. Confirm the Production Web deployment points to the reviewed Web
   commit and inspect the release receipts and normal error monitoring.
   Category activation and identity enforcement require a separate release.

## Rollback and partial failure

Redeploy the previous same-environment Web artifact if the Web release needs
rollback. Keep the database gates off and retain the CLI ledger. Each SQL
file is transactional. A failure after an earlier successful migration
can leave a disabled prefix installed. Preserve the failure output and
completed receipts, halt Web promotion, and have the release owner prepare
a separately reviewed forward fix using the observed ledger and disabled
state. The full batch rejects a partial installation on redispatch. Leave
existing ledger entries in place during recovery.
