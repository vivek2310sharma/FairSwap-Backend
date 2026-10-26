-- Separate owner authorization required. No secrets returned, rotated or embedded.
-- A matching existing private worker URL must independently identify this environment.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select app_security.provision_chat_safety_project_url('wpppxlnbzqynvhpeuavd');
commit;
