# Seller profile search RPC release receipt — 2026-10-24

## Source and scope

- Backend source PR: #51 (squash merged as `dcef52586cd2fd9cc72fc716dfeb9fd102d002a9`).
- Forward-only source file: `supabase/forward-migrations/seller-profile/20261024100000_search_seller_public_listings.sql`.
- GitHub blob SHA: `4adcef32cc69a35018404c9c018e67f6ab945ca2`.
- Adds `app_security.impl_search_seller_public_listings` and `public.search_seller_public_listings`, including grants; no table changes and no legacy migrations replayed.

## Hosted migration records

| Environment | Project | Migration version | Migration name |
| --- | --- | --- | --- |
| FairSwapTest | `wpppxlnbzqynvhpeuavd` | `20261024152605` | `seller_profile_search_public_listings_20261024` |
| FairSwapProd | `kriuhwppxgxsyyrbjsau` | `20261024152633` | `seller_profile_search_public_listings_20261024` |

Applied via Supabase's project-scoped managed migration interface, Test before Production, after explicit owner request in ChatGPT. The 58-file historical baseline was **not** used for deployment; no raw `supabase db push`.

## Evidence

- Before application, the original `search_public_listings` RPC was present and the new seller RPC was absent on both projects.
- Both migrations returned `success: true` and appeared in the hosted migration ledgers.
- Post-release SQL read-only checks returned `true` in each project for: null seller count zero, invalid condition zero, unknown category zero, stop-word-only query zero, inverted price range zero, `anon` EXECUTE, and `authenticated` EXECUTE.
- Backend source GitHub CI completed successfully before release. The authored pgTAP SQL test was **not executed**.
- This receipt does **not** attest to independent backup/restore proof or completion of the broader Backend-only deployment-ownership cutover. Those remain separate release-governance items.

## Consumer and rollback

The focused Web staging and production feature relies on this new RPC. Safe rollback order is: restore the previous Web deployment/commit first; leave the additive RPC unused, or remove it later using a separately approved forward migration. No new environment variables.
