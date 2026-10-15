-- Migration 18: 20260916000018_performance_and_reliability_indexes.sql
-- High-value access pattern index optimization for Point 15 Reliability & Query Bounds

-- 1. Moderation Queue Index
-- Fast bounded ordered scans for pending review queue (eliminates in-memory sort)
CREATE INDEX IF NOT EXISTS idx_listings_moderation_queue
ON public.listings (status, submitted_at ASC)
WHERE status = 'pending_review';

-- 2. Seller Listings Index
-- Ordered retrieval of seller's listings by recency
CREATE INDEX IF NOT EXISTS idx_listings_seller_updated
ON public.listings (seller_id, updated_at DESC);

-- 3. Support Tickets Admin Queue Index
-- Supports staff queue filtering by status ordered by last update
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_updated
ON public.support_tickets (status, updated_at DESC);

-- 4. Privacy Requests Admin Queue Index
-- Supports privacy fulfillment queue ordered by requested_at
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status_requested
ON public.privacy_requests (status, requested_at DESC);

-- 5. Privacy Requests User Quota Index
-- Accelerates rolling 30-day window quota lookups
CREATE INDEX IF NOT EXISTS idx_privacy_requests_user_quota
ON public.privacy_requests (user_id, requested_at DESC);
