-- Migration 29: 20261001000029_fix_listing_landmark_column_permissions.sql
-- Grant column-level INSERT and UPDATE privileges on public.listings.landmark to authenticated role.
-- Landmark persistence required column-level permissions discovered during staging QA.

GRANT INSERT (landmark), UPDATE (landmark)
ON public.listings
TO authenticated;
