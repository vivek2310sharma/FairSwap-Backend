-- Owner-private profile details (full name, PIN, canonical locality/district ids,
-- language, onboarding completion). Additive only. No client DML: all writes go
-- through app_security RPCs (see 20261025100003). Never join this table into any
-- public projection except via public_profile_location (names only, no PIN).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.user_private_details (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  pin_code text,
  locality_id uuid REFERENCES public.localities(id) ON DELETE SET NULL,
  city_id uuid REFERENCES public.cities(id) ON DELETE SET NULL, -- district compatibility id
  state text,
  preferred_language text NOT NULL DEFAULT 'en',
  onboarding_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT chk_upd_pin_code CHECK (pin_code IS NULL OR pin_code ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT chk_upd_full_name CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 1 AND 100),
  CONSTRAINT chk_upd_language CHECK (preferred_language IN ('en'))
);

ALTER TABLE public.user_private_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_private_details FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_private_details FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_private_details TO authenticated;

-- Owner read only. Deliberately NOT gated on account status / policy acceptance so
-- restricted owners can still see their own data (privacy rights). No INSERT/UPDATE/
-- DELETE policy exists and no DML grant is given: definer RPCs are the only writers.
DROP POLICY IF EXISTS user_private_details_owner_select ON public.user_private_details;
CREATE POLICY user_private_details_owner_select ON public.user_private_details
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.enforce_user_private_details_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'user_private_details.user_id is immutable';
    END IF;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_private_details_integrity ON public.user_private_details;
CREATE TRIGGER trg_user_private_details_integrity
BEFORE INSERT OR UPDATE ON public.user_private_details
FOR EACH ROW EXECUTE FUNCTION public.enforce_user_private_details_integrity();

-- Trigger function: never callable as an RPC by client roles (EXECUTE is checked only at CREATE TRIGGER).
REVOKE ALL ON FUNCTION public.enforce_user_private_details_integrity() FROM PUBLIC, anon, authenticated;

commit;
