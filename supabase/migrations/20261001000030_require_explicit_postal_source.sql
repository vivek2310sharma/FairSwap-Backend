-- Migration 30: 20261001000030_require_explicit_postal_source.sql
-- Require explicit provenance for all postal data records by dropping default on source.
-- data.gov.in provenance must never be assigned implicitly.

ALTER TABLE public.india_postal_data
  ALTER COLUMN source DROP DEFAULT;
