# GitHub Free private Backend releases

FairSwap's private cutover is scheduled for 1 December 2026. The owner reviews
the exact Backend main commit and dispatches the manual release. The active
migration workflows require the private Backend repository, main, the owner as
both original and rerun actor, and the reviewed SHA. They use successful push CI
for that SHA and enforce candidate-specific Test evidence before Production.
GitHub Free ignores existing Environment secrets and deployment protection after
a public-to-private switch. Repository secrets rely on owner-only write access
to branches and workflows. Review Apps, deploy keys, machine credentials and
any workflow that runs code from a contributor before placing credentials.
[GitHub Environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

## Credential and configuration migration

All new repository entries below go in **FairSwap-Backend Actions** after it is
private. Test means FairSwapTest (`wpppxlnbzqynvhpeuavd`). Prod means FairSwapProd
(`kriuhwppxgxsyyrbjsau`). The table lists names from source. Hosted settings and
credential availability were unverified during patch preparation.

| Existing name and location | Proposed name and location | Scope and required configuration |
| --- | --- | --- |
| `FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN`, repository secret | Same | Reuse the Test project-scoped PAT. Project Settings, API Keys, and API Key Secrets Read for CLI link. |
| `FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN`, repository secret | Same | Reuse the Prod project-scoped PAT. Same project permissions as Test. The existing DigiLocker parity path also requires Edge Functions Read-write and Edge Function Secrets Read in Prod. |
| `CHAT_DATABASE_PASSWORD`, Test Environment secret | `FAIRSWAP_TEST_DB_PASSWORD`, repository secret | Test database migration login for `postgres.<Test ref>`. |
| `CHAT_DATABASE_PASSWORD`, Prod Environment secret | `FAIRSWAP_PROD_DB_PASSWORD`, repository secret | Prod database migration login for `postgres.<Prod ref>`. |
| `CHAT_DB_SSL_ROOT_CERT_PEM`, Test Environment secret | `FAIRSWAP_TEST_DB_SSL_ROOT_CERT_PEM`, repository secret | Test project's trusted CA certificate PEM for verified TLS. |
| `CHAT_DB_SSL_ROOT_CERT_PEM`, Prod Environment secret | `FAIRSWAP_PROD_DB_SSL_ROOT_CERT_PEM`, repository secret | Prod project's trusted CA certificate PEM for verified TLS. |
| `CHAT_DB_POOLER_HOST`, Test Environment variable | `FAIRSWAP_TEST_DB_POOLER_HOST`, repository variable | Test Session pooler raw hostname from the project connection settings. The workflow fixes port 5432 and verifies TLS. |
| `CHAT_DB_POOLER_HOST`, Prod Environment variable | `FAIRSWAP_PROD_DB_POOLER_HOST`, repository variable | Prod Session pooler raw hostname from the project connection settings. The workflow fixes port 5432 and verifies TLS. |
| `CHAT_RELEASE_AUDIT_TOKEN`, referenced in protected Environments and reusable evidence steps | `FAIRSWAP_WEB_EVIDENCE_TOKEN`, repository secret | Fine-grained credential for **FairSwap-Web only**, with Actions Read, Contents Read and Deployments Read for the existing cross-repo evidence checks. Reuse an existing credential only if it already has this scope. Retire Backend administration audit access after checking consumers. |
| Automatic `GITHUB_TOKEN` | Same automatic token | Backend Actions Read and Contents Read for exact-commit CI, source and Backend receipts. No stored credential. |
| `FSW_SEC_003_RELEASE_ENABLED`, `FSW_AUTHORITY_PUBLIC_KEY_PEM`, `FSW_SEC_003_PRELAUNCH_AUTHORITY_DEFERRED`, `CHAT_INBOX_RELEASE_ENABLED`, `CHAT_INBOX_ENVIRONMENT_ENABLED`, `CHAT_WEB_FLAG_OFF_CONFIRMED` | Retire from active release configuration | Historical workflow settings. Preserve receipts and existing application flags. |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `OPENAI_API_KEY`, `AZURE_MODERATION_SECRET` | No migration | Inactive Azure workflow. Preserve cloud configuration. |
| `GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GOOGLE_CLOUD_MODERATION_SECRET`, unscoped `SUPABASE_ACCESS_TOKEN` | No migration | Inactive Google workflow. Preserve cloud configuration. |
| `FAIRSWAP_TEST_SERVICE_ROLE_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY` | Only `FAIRSWAP_TEST_SERVICE_ROLE_KEY` referenced by inactive Google workflow | Test-only legacy scan key. Leave unprovisioned for this cutover. |
| `FAIRSWAP_PROD_SERVICE_ROLE_KEY`, `SUPABASE_PROD_SERVICE_ROLE_KEY` | Only `FAIRSWAP_PROD_SERVICE_ROLE_KEY` referenced by inactive Google workflow | Prod-only legacy scan key. Leave unprovisioned for this cutover. |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_KEY` | Remove Google workflow fallback references | Leave application runtime keys in their existing stores. |

[Supabase scoped PAT permissions](https://supabase.com/docs/guides/platform/personal-access-tokens)

## Cutover order

1. Freeze release dispatches and ensure queued, in-progress and waiting release
   runs are cleared. Confirm owner-only repository write access and inspect
   cross-repository consumers of private source or artifacts. Retain release
   receipts and source revisions needed for audit.
2. Make FairSwap-Backend private before adding the new repository secrets. Make
   FairSwap-Web private as scheduled and ensure its evidence credential can read
   the private repo. Preserve its existing Contents-read access to pinned Backend
   source. Keep releases frozen until configuration and reviewed workflow code
   are in place.
3. Install the reviewed Backend changes and the exact repository entries in the
   table. Use the owner's secure credential source or reissue a scoped credential
   when necessary. Verify names and scopes without exposing values. Leave Azure
   and Google disabled. Their original `environment: FairSwapTest` and
   `environment: FairSwapProd` references preserve historical OIDC subject
   configuration. Any future provider activation needs separately reviewed
   federation trust for the actual OIDC subject and audience. Do not widen
   existing trust or assume a main ref subject matches an Environment subject.
   [GitHub OIDC subject claims](https://docs.github.com/en/actions/reference/security/oidc#example-subject-claims)
4. For a separately authorized release, review the SHA and candidate, confirm
   independent CI on that SHA, then use the applicable workflow's automated Test
   and Production sequence. Inspect the Production postflight receipt for the
   source, project, migration and history checks. For candidates requiring a
   separate Production dispatch, supply only the Test run and other evidence
   required by the existing candidate contract.
5. On a cutover failure, freeze dispatches and remove or rotate the newly scoped
   repository credentials as appropriate. Correct configuration while private.
   Before any return to public visibility, remove the migrated privileged
   repository secrets and resolve queued or running releases. If a migration was
   attempted, use the candidate's postflight and recovery instructions. Preserve
   migration ledger entries.

## Workflow disposition

ChatGPT independently verified that both FairSwapTest and FairSwapProd record
`20261025204922_chat_v2_inbox_and_safety` and
`20261031110408_fsw_sec_003_public_search_hardening` as applied. The earlier
[31 October migration snapshot](../../releases/candidates/fsw-sec-003/history-snapshot.json)
also records the Chat migration in both projects.

- **Chat V2 inbox release and protection audit** are retired in place. CI still
  exercises the retained release scripts and bundle inputs.
- **FSW-SEC-003 prelaunch, protected release and evidence audit** are retired in
  place. The audit has no active release consumer. Preserve the historical
  workflows, release logic, receipts and security tests. The reusable pipeline
  still imports the exact-SHA CI and TLS certificate helpers. The retired jobs
  require no credential migration. The active pipeline still uses the named
  project-specific database credentials above.
- **Azure and Google moderation** have disabled build and publish entry jobs.
  The downstream OIDC jobs cannot run through those entry points. The Azure CI
  workflow still observes its existing path filter.
