-- Migration 7: 20260914000007_create_storage_buckets_and_policies.sql
-- Storage Buckets (Private) and Server-Mediated Access Boundary

-- 1. Create Private Buckets in storage.buckets
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'listing-originals',
    'listing-originals',
    false,
    5242880, -- 5 MB
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
  ),
  (
    'listing-derivatives',
    'listing-derivatives',
    false,
    5242880, -- 5 MB
    ARRAY['image/webp']::text[]
  )
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. Storage Access Control
-- Per Binding Amendment 6:
-- Storage is fully server-mediated.
-- Both buckets are strictly private (public = false).
-- No policies are granted to 'anon' or 'authenticated' on these buckets.
-- All writes, deletes, and signed URL issuances are executed server-side via the service-role client.
