ALTER POLICY admin_pending_medium_download
ON storage.objects
USING (
  bucket_id = 'listing-derivatives'
  AND storage.allow_any_operation(ARRAY[
    'object.get_authenticated_info',
    'object.get_authenticated'
  ])
  AND app_security.is_active_staff_aal2('moderator'::public.staff_role_enum)
  AND app_security.has_current_policy_acceptance(auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.listing_media m
    JOIN public.listings l ON l.id = m.listing_id
    WHERE m.processing_status = 'ready'::public.media_processing_status_enum
      AND l.status = 'pending_review'::public.listing_status_enum
      AND m.medium_storage_path = storage.objects.name
  )
);