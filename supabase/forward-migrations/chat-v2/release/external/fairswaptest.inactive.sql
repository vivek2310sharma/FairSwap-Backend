-- Owner-authorized inactive Test configuration only; no net/cron job or project_url required.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select app_security.configure_chat_safety_external_inactive('wpppxlnbzqynvhpeuavd');
commit;
