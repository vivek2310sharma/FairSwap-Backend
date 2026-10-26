-- Minimal dependency tables for REAL canonical dispatch bodies, not replacement dispatchers.
create table public.email_outbox(id uuid primary key default gen_random_uuid());
create type public.moderation_request_status as enum('queued','claimed','failed','retry');
create type public.moderation_outcome_enum as enum('checks_incomplete');
create type public.moderation_decision_state as enum('escalated_to_admin');
create table public.listing_moderation_requests(
 id uuid primary key default gen_random_uuid(),listing_id uuid default gen_random_uuid(),
 listing_revision integer default 1,generation_id uuid default gen_random_uuid(),
 status public.moderation_request_status default 'queued',claim_token uuid,claim_expires_at timestamptz,
 attempt_count integer default 0,max_attempts integer default 5,updated_at timestamptz,next_attempt_at timestamptz
);
create table public.listing_moderation_results(
 request_id uuid,listing_id uuid,listing_revision integer,generation_id uuid,
 outcome public.moderation_outcome_enum,ruleset_version text,scope text,completed_rules text[],failed_rules text[],
 flags jsonb,errors jsonb,decision public.moderation_decision_state
);
