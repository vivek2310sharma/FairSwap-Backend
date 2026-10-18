# Manual scoped-token validation — FairSwap-Backend

**Status (18 October 2026): VERIFIED FOR READ-ONLY SCOPED PROJECT ACCESS ONLY.** The repository owner created two scoped Supabase tokens and stored them as encrypted **FairSwap-Backend repository-level Actions secrets**. Both values were exercised by separate successful manually dispatched Actions jobs, and the opposite project rejected each token. Neither value was printed or inspected. This page and `backend-scoped-token-check.yml` document only this limited verification; they do **not** configure database migrations, hosted Supabase deployments, or approval protection.

## Secret-to-project mapping

| GitHub Actions secret in FairSwap-Backend | Supabase project | Intended scope |
| --- | --- | --- |
| `FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN` | FairSwapTest `wpppxlnbzqynvhpeuavd` | Project-scoped Test only |
| `FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN` | FairSwapProd `kriuhwppxgxsyyrbjsau` | Project-scoped Production only |

**Never put the values into a source file, PR, ChatGPT, issue, logs, `FairSwap-Web`, or the Web runtime environment.** Also save the tokens in an encrypted password manager and erase temporary Notepad copies after verifying the manager entries.

## Exactly how to verify access (requires separate authorization for Actions minutes)

1. Open [Backend GitHub Actions](https://github.com/vivek2310sharma/FairSwap-Backend/actions).
2. Select **[MANUAL] Verify Backend Supabase token scopes (read-only)**, **Run workflow** from `main`, target **test**. Only the owner `vivek2310sharma` is allowed to run a credential-bearing job.
3. This makes exactly two **GET** requests with the Test token: the Test project's `/v1/projects/{ref}` must return HTTP 200; the Production project must return HTTP 403/404. **No data/secret body is logged.**
4. Only after an explicit user approval for Production token verification, repeat with target **production**. The Production project must return HTTP 200 and the Test project HTTP 403/404.
5. A missing secret, wrong scope, error, or unexpectedly broad permission **fails closed**. The workflow has no checkouts, no SQL commands, no deploy steps, no migrations, no `supabase link`, and no automatic trigger.

The `Project Settings: Read` scope is required for the read-only GET endpoint. The workflow does not verify write permissions; **passing it must never be treated as release authorization**.

## Executed read-only verification evidence — 18 October 2026

| Target | GitHub Actions run | Executed job | Outcome |
| --- | --- | --- | --- |
| FairSwapTest | [39126378994](https://github.com/vivek2310sharma/FairSwap-Backend/actions/runs/39126378994) | `verify-test` succeeded; Production job skipped | Target HTTP 200; opposite project HTTP 403/404; zero writes |
| FairSwapProd | [39126417831](https://github.com/vivek2310sharma/FairSwap-Backend/actions/runs/39126417831) | `verify-production` succeeded; Test job skipped | Target HTTP 200; opposite project HTTP 403/404; zero writes |

GitHub job summaries and job logs were inspected; each printed the expected final `PASS` confirmation. Successful dispatch confirms tokens are available to the relevant jobs but **does not verify SQL-write access or whether an unauthorized workflow editor could access a repo-level never-expiring token**. No further Actions run is required for token identity acceptance.

## Important remaining release limits

- `FairSwapTest` currently has **61** applied migrations, versus **58** original source SQL files tracked by this repository. Three Test-only ledger versions have no file in the current 58-file source: `20261010214201`, `20261017125456`, and `20261017172840`.
- `FairSwapProd` currently has **52** applied migrations (45 original baseline + 7 approved forward-only versions). **Neither** environment may receive a raw `supabase db push` from the 58-file source directory. Reconcile exact isolated environment histories and review proposed future SQL separately.
- Supabase administrative API tokens are **not the application's runtime Supabase keys** and are not necessarily sufficient for the CLI's direct database connection or remote migration operations. No new database password has been created or stored here.
- GitHub Free private-repository **repository-level** secrets do not receive the environment approval/branch restrictions available on paid plans. The repo-owner actor/ref guards here prevent accidental dispatch, but a user who can modify trusted repository workflows may bypass them. **Never treat this workflow as strong protection for a never-expiring Production PAT.** Keep collaborators and workflow write access tightly controlled; move the Production secret to protected environment storage or an external vault if the risk becomes unacceptable.
- No always-on CI/CD or automatic Production release workflow is enabled. Do not enable remote writes without a tested approval system and an audited isolated 52-version Production baseline.
- Previous manual/CLI access tokens and remote deployment entry points are not proven revoked. Verify which remain needed, revoke only obsolete ones, and record negative proof that Web-based/manual release credentials are no longer active before calling Backend the **sole** deploy operator.

See [Backend deployment-owner cutover](BACKEND_ONLY_RELEASE_CUTOVER.md) and [Supabase PAT scope documentation](https://supabase.com/docs/guides/platform/personal-access-tokens).
