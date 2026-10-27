# Unresolved authority and recovery gates

Release disposition: BLOCKED for Test and Production. No hosted writes authorized.

| Condition | Evidence required, without credentials | Status |
|---|---|---|
| Current complete isolated histories | 87 Test / 71 Prod exact version/name/statement fingerprints captured; authoritative reviewed raw-file mapping and operator receipts for every prior version | BLOCKED source provenance |
| Production 20261023160752 | Recover original SQL/checksum and authorized application receipt from its release owner; reconcile NULL ledger statements without fabricating or silently repairing history | BLOCKED unavailable statements |
| All privileged writers inventoried | Metadata-only inventories from Web staging/main Actions environments/secrets/variables, Vercel integrations/env names, Supabase org/project memberships, external runners, service principals, manual Windows/Mac CLI credentials, database login principals and privileged keys; owner and retirement decision for each | BLOCKED |
| Four legacy personal PATs revoked | Existing 18 Oct owner attestation is retained, not independent proof. Supabase credential metadata/audit revocation records tied to safe token IDs, or authorized old-path negative read/permission tests in a controlled runner that outputs only identity ID, endpoint class, timestamp, 401/403 and audit ref | BLOCKED independent proof |
| Old Web/manual deployment paths cannot write | Source freeze is historical evidence only. Review current merged source/config; prove deploy credential removal/role revocation across all identified paths with provider permission metadata. Where legitimate old credentials remain in secure custody, separate authorized negative authorization checks must avoid SQL/DDL, writes, token echoes and verbose logs. A 401/403 read denial supports only that identity/path, not all writers. If credentials are destroyed, use provider revocation/audit evidence rather than requesting token values | BLOCKED |
| No overlap before Backend grant | Dated revocation/inventory signoff precedes a distinct Backend-only principal; project-scoped least privilege for each environment; audit all residual owner/break-glass identities and restrict their use under Backend release procedure | BLOCKED |
| Protected Backend operator authority | Provider principal ID/scope, separate Test/Prod binding, protected environment or equivalent approved operator procedure, independent human reviewer, approval audit, branch/revision and migration hash binding, concurrency/release lock, no self-approval/bypass, dry-run/ledger guard, traceable execution/rollback logs. No deploy workflow is introduced here | BLOCKED |
| Existing scoped tokens | 18 Oct read-isolation checks show only project read isolation. They do not establish least-privilege write scope, protected approval or exclusive Backend authority. Do not run/change backend-scoped-token-check.yml | UNVERIFIED authority |
| Current Test backup/restore | Backup ID/time for the current release window, coverage through pre-apply point, successful isolated restore of that backup, integrity/ACL/export results, measured RPO/RTO, recovery operator and secure evidence reference | BLOCKED |
| Current Production backup/restore | Independent Production proof with the same fields; never substitute Test proof, backup existence alone or old rehearsal | BLOCKED |
| Privileged worker-trigger grants | Review public.handle_listing_moderation_enqueue and app_security.trg_fn_notify_moderation_worker broad EXECUTE grants; record risk disposition without silently granting/revoking in Ratings | OPEN independent review |
| Release revision and CI | ChatGPT verifies PR #59 exact reviewed commit, six bytes and all existing CI gates at that revision; local observed HEAD is not proof of PR synchronization | BLOCKED integration evidence |
| Complete installed-chain/performance checks | Automated PG17 replay of independently reconstructed current histories, real cron compatibility, safe scheduler catch-up, concurrency/load qualification and consumer release artifact checks | BLOCKED / NOT RUN as scoped in checks.json |
| Consumer staging/production mappings | Web/Admin reviewed build IDs, target environment/project binding and flag names/values OFF; preserve all existing gates. Unknown mappings are not guessed | UNVERIFIED |

Do not inspect or disclose token values, old PATs, runtime keys, Vault contents,
database passwords, dumps or private records. Do not revoke necessary Web runtime
keys as part of writer revocation. High-privilege runtime identities must be separately
inventoried and their operational access controlled; runtime functionality must survive.
No authorized write test is part of this readiness package. Do not claim that lack
of deployment source code proves account-level inability to deploy.

Close each environment's blockers in its own signed release receipt, with links/hashes
to restricted evidence, owner/reviewer and UTC timestamp. Revalidate at release time.
Preparation, a merge, a passing test or a secret's presence does not authorize apply.
