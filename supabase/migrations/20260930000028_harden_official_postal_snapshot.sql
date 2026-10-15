-- Migration 28: 20260930000028_harden_official_postal_snapshot.sql
-- Harden India postal schema and lookup for official data.gov.in snapshot (#81):
-- 1. Introduce deterministic source_record_key on public.india_postal_data.
-- 2. Upgrade uniqueness constraint to UNIQUE (source, source_record_key) allowing duplicate office names with differing metadata.
-- 3. Filter out official sentinel administrative values ('NA', 'N/A', 'NULL', 'NONE', '-', '--').
-- 4. For PINs with no usable administrative boundaries, return PINCODE_ADMIN_DATA_UNAVAILABLE.
-- 5. For PINs with valid rows + NA rows, resolve administrative boundaries strictly from valid rows.

-- A. Add and backfill source_record_key on public.india_postal_data
ALTER TABLE public.india_postal_data 
  ADD COLUMN IF NOT EXISTS source_record_key text;

UPDATE public.india_postal_data
SET source_record_key = md5(
  concat_ws('|',
    lower(regexp_replace(trim(COALESCE(pincode, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(office_name, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(office_type, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(delivery_status, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(division, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(region, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(circle, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(taluk, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(district, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(trim(COALESCE(state, '')), '\s+', ' ', 'g'))
  )
)
WHERE source_record_key IS NULL;

-- Remove any duplicate source_record_keys before applying unique constraint
DELETE FROM public.india_postal_data a
USING public.india_postal_data b
WHERE a.ctid < b.ctid
  AND a.source = b.source
  AND a.source_record_key = b.source_record_key;

ALTER TABLE public.india_postal_data 
  ALTER COLUMN source_record_key SET NOT NULL;

-- B. Update uniqueness constraint from (pincode, office_name) to (source, source_record_key)
ALTER TABLE public.india_postal_data 
  DROP CONSTRAINT IF EXISTS uq_india_postal_data_pincode_office;

ALTER TABLE public.india_postal_data 
  DROP CONSTRAINT IF EXISTS uq_india_postal_data_source_record_key;

ALTER TABLE public.india_postal_data 
  ADD CONSTRAINT uq_india_postal_data_source_record_key UNIQUE (source, source_record_key);

CREATE INDEX IF NOT EXISTS idx_india_postal_data_source_record_key 
  ON public.india_postal_data(source, source_record_key);

-- C. Trigger to ensure deterministic source_record_key is always populated/recomputed on INSERT or UPDATE
CREATE OR REPLACE FUNCTION public.generate_postal_source_record_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.source_record_key := md5(
    concat_ws('|',
      lower(regexp_replace(trim(COALESCE(NEW.pincode, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.office_name, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.office_type, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.delivery_status, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.division, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.region, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.circle, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.taluk, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.district, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(COALESCE(NEW.state, '')), '\s+', ' ', 'g'))
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_india_postal_data_source_record_key ON public.india_postal_data;
CREATE TRIGGER trg_india_postal_data_source_record_key
BEFORE INSERT OR UPDATE ON public.india_postal_data
FOR EACH ROW
EXECUTE FUNCTION public.generate_postal_source_record_key();

-- D. Update public.lookup_pincode to handle sentinel NA administrative values
CREATE OR REPLACE FUNCTION public.lookup_pincode(p_pincode text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pincode text := trim(p_pincode);
  v_total_raw_rows integer;
  v_state_count integer;
  v_district_count integer;
  v_state text;
  v_single_district text;
  v_single_city_id uuid;
  v_districts jsonb;
  v_postal_records jsonb;
  v_localities jsonb;
BEGIN
  IF v_pincode IS NULL OR v_pincode !~ '^\d{6}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_PINCODE',
      'message', 'PIN code must be exactly 6 numeric digits'
    );
  END IF;

  -- 1. Check whether this PIN code exists at all in the raw postal records
  SELECT count(*)
  INTO v_total_raw_rows
  FROM public.india_postal_data
  WHERE pincode = v_pincode;

  IF v_total_raw_rows = 0 OR v_total_raw_rows IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PINCODE_NOT_FOUND',
      'message', 'PIN code not found in postal database'
    );
  END IF;

  -- 2. Count distinct valid states and districts, strictly excluding sentinel NA values
  SELECT 
    count(DISTINCT lower(trim(state))),
    count(DISTINCT lower(trim(district))),
    min(state)
  INTO v_state_count, v_district_count, v_state
  FROM public.india_postal_data
  WHERE pincode = v_pincode
    AND lower(trim(state)) NOT IN ('', 'na', 'n/a', 'null', 'none', '-', '--')
    AND lower(trim(district)) NOT IN ('', 'na', 'n/a', 'null', 'none', '-', '--');

  -- If all rows for this PIN code have sentinel/missing administrative values
  IF v_state_count = 0 OR v_district_count = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PINCODE_ADMIN_DATA_UNAVAILABLE',
      'message', 'We recognize this PIN code, but its location details are currently unavailable'
    );
  END IF;

  -- Cross-state PIN codes represent a genuine administrative boundary conflict; fail closed
  IF v_state_count > 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'CONFLICTING_POSTAL_STATES',
      'message', 'PIN code maps to multiple states'
    );
  END IF;

  -- 3. Build distinct valid districts within this state and resolve compatibility city_id
  WITH distinct_districts AS (
    SELECT DISTINCT ON (lower(trim(district)))
      district AS district_name
    FROM public.india_postal_data
    WHERE pincode = v_pincode
      AND lower(trim(state)) NOT IN ('', 'na', 'n/a', 'null', 'none', '-', '--')
      AND lower(trim(district)) NOT IN ('', 'na', 'n/a', 'null', 'none', '-', '--')
    ORDER BY lower(trim(district)), district ASC
  ),
  resolved_districts AS (
    SELECT 
      dd.district_name,
      c.id AS city_id
    FROM distinct_districts dd
    LEFT JOIN public.cities c
      ON c.is_active = true
     AND lower(c.name) = lower(dd.district_name)
     AND lower(c.state) = lower(v_state)
    ORDER BY dd.district_name ASC
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', district_name,
      'city_id', city_id
    )
  )
  INTO v_districts
  FROM resolved_districts;

  -- If exactly one usable district exists, resolve top-level district, city, city_id
  IF v_district_count = 1 THEN
    v_single_district := v_districts->0->>'name';
    IF v_districts->0->>'city_id' IS NOT NULL THEN
      v_single_city_id := (v_districts->0->>'city_id')::uuid;
    ELSE
      v_single_city_id := NULL;
    END IF;
  ELSE
    v_single_district := NULL;
    v_single_city_id := NULL;
  END IF;

  -- 4. Fetch raw postal records from india_postal_data (source NA values preserved for reference)
  SELECT 
    jsonb_agg(
      jsonb_build_object(
        'office_name', office_name,
        'office_type', office_type,
        'delivery_status', delivery_status,
        'division', division,
        'region', region,
        'circle', circle,
        'taluk', taluk,
        'district', district,
        'state', state
      ) ORDER BY office_name ASC
    )
  INTO v_postal_records
  FROM public.india_postal_data
  WHERE pincode = v_pincode;

  -- 5. Fetch linked FairSwap localities for this pincode (ignoring sentinel city records)
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', l.id,
      'name', l.name,
      'slug', l.slug,
      'city_id', l.city_id,
      'city_name', c.name,
      'district', c.name,
      'state', c.state
    ) ORDER BY l.name ASC
  )
  INTO v_localities
  FROM public.postal_pincode_localities ppl
  JOIN public.localities l ON l.id = ppl.locality_id
  JOIN public.cities c ON c.id = l.city_id
  WHERE ppl.pincode = v_pincode
    AND l.is_active = true
    AND c.is_active = true
    AND lower(trim(c.name)) NOT IN ('', 'na', 'n/a', 'null', 'none', '-', '--')
    AND lower(trim(c.state)) NOT IN ('', 'na', 'n/a', 'null', 'none', '-', '--');

  RETURN jsonb_build_object(
    'success', true,
    'pincode', v_pincode,
    'state', v_state,
    'district', v_single_district,
    'city', v_single_district, -- legacy backwards-compatibility alias; represents district, NEVER taluk
    'city_id', v_single_city_id,
    'districts', COALESCE(v_districts, '[]'::jsonb),
    'localities', COALESCE(v_localities, '[]'::jsonb),
    'postal_offices', COALESCE(v_postal_records, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_pincode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_pincode(text)
  TO anon, authenticated, service_role;
