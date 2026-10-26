-- Owner-run ONLY after Test evidence, protected release authority and exact Prod ledger review.
-- Requires the existing Vault project_url to identify FairSwapProd. No credential literals.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select app_security.chat_safety_release_preflight('kriuhwppxgxsyyrbjsau');
select app_security.configure_chat_safety_inactive('kriuhwppxgxsyyrbjsau');
commit;
