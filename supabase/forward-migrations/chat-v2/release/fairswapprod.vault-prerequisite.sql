-- Separate owner authorization required after Test evidence and exact Prod target review.
-- A matching existing private worker URL must independently identify this environment.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select app_security.provision_chat_safety_project_url('kriuhwppxgxsyyrbjsau');
commit;
