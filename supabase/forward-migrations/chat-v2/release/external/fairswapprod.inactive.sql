-- Owner-authorized inactive Prod configuration, after automated Test evidence.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select app_security.configure_chat_safety_external_inactive('kriuhwppxgxsyyrbjsau');
commit;
