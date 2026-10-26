-- Owner-run ONLY after separately authorized ledger reconciliation and forward migration review.
-- Requires the existing Vault project_url to identify FairSwapTest. No credential literals.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select app_security.configure_chat_safety_inactive('wpppxlnbzqynvhpeuavd');
commit;
