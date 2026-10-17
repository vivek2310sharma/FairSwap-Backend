# Staging-only deployment receipts

These files preserve evidence for the two explicitly executed **FairSwapTest** migrations on 17 October 2026. They are deliberately outside `supabase/migrations/` so the canonical set of **58 hashed migrations** and its CI verifier remain unchanged.

- `20261017125456_*.sql` preserves the reviewed proposed Test-specific finalizer source. It depends on experimental guards and must not be run on Production.
- `20261017172840_*.sql` documents the guarded Test-specific enqueue-trigger repair; its preconditions reject other environments.

Do not auto-discover or run these files from a CI/CD pipeline. See `docs/releases/2026-10-17-moderation-staging-receipt.md` for release scope, evidence, and the Production no-go boundary.
