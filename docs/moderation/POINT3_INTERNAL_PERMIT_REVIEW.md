# Point 3: narrow legacy media-invalidation permit — conditional CTO approval

CTO approved implementation and Test verification with conditions in this chat on 19 October 2026. Contract section 3.1's separate review gate is satisfied for this narrow permit only. No permit has yet been committed to FairSwapTest. Cover deletion/fallback and asynchronous readiness need separate authority; failures on those paths must remain blocked.

## Exact need

Existing `public.handle_listing_media_reorder_statement` / deletion / readiness triggers call the generic owner-owned `app_security.trigger_listing_media_rereview`. For V2 that helper's parent UPDATE correctly fails the new executing-role guard. A broad postgres exemption would also allow legacy owner-owned approval RPCs through the guard and is rejected.

## Proposed bounded capability

Add a private transient `modv2_private.invalidation_permits` table with:

```sql
transaction_id xid8 NOT NULL,
backend_pid integer NOT NULL,
listing_id uuid NOT NULL,
expected_revision integer NOT NULL,
remaining integer NOT NULL CHECK (remaining BETWEEN 0 AND 1),
PRIMARY KEY (transaction_id,backend_pid,listing_id)
```

Only the narrow `mv2_edit` function owner may INSERT/DELETE. The guard owner may consume the single permission. Ordinary roles, generic postgres-owned application RPCs and trusted runtime callers have no direct table DML. Operator/DDL credentials remain outside this enforcement boundary. The proposed issuer additionally requires an independently authenticated restricted LOGIN with SET membership in `mv2_media_editor`, no finalizer membership, and an attested seller matching the listing with active account/current policy. The postgres controller is explicitly rejected by this API. JWT/GUC identity alone is insufficient. Ordinary shared service-role/PostgREST credentials receive no media-editor authority; a future separately credentialed broker must validate seller sessions before attesting that identity.

After validating the actual authenticated seller, active account, policy acceptance, expected revision and media ownership, the trusted media-edit RPC locks the parent and ordered media, then inserts the row using server-derived `pg_current_xact_id()` and `pg_backend_pid()`. It creates the permit only around a single media statement that is known to invoke the historical invalidation helper, and removes it before returning. Exception rollback removes it as well.

The executing-role guard may consume that row ONLY when all conditions hold:

1. The actual DML executor is the expected legacy helper owner from the inspected baseline.
2. Transaction, backend and listing exactly match the private record, with remaining=1.
3. The old parent revision equals expected_revision; new revision is exactly old+1.
4. Status remains pending_review or withdraws active/reserved/paused to pending_review.
5. Every other parent column is identical except the exact pre-existing invalidation timestamps (`updated_at`, `submitted_at`). No title, description, seller, category, cover, identity, publication timestamp or path change is admitted.
6. Atomic UPDATE consumes remaining to zero before admitting the parent mutation. A second attempt is denied.

This cannot authorize publication, media-path writes, enrollment changes, evidence insertion or role switching. It does not trust JWT/GUC/internal booleans, trigger depth, supplied role names or a generic postgres identity alone. Neither historical function bodies nor trigger enablement changes.

## Required negative tests before acceptance

- service_role direct INSERT/UPDATE/DELETE of permit is denied.
- Fake JWT, GUC, supplied backend/transaction or unrelated session cannot create/use a permit.
- Wrong listing, old revision, second use or changed title/cover/owner/category/publication fields is denied.
- Legacy reviewed/unreviewed approval trampolines remain denied.
- Legitimate owner reorder/delete executes the historical revision increment exactly once.
- Exception/rollback and successful return both leave no permit row.
- Parent-first edit/finalize/retire races never attach stale evidence or publish.

## Decision

Implement only the approved capability and mandatory negative tests. Cover deletion/fallback remains fail-closed with an explicit error. The ordinary asynchronous processor remains denied for enrolled V2 media; no permit is minted for it. Report those integration blockers instead of adding authority. Keep all V1 function bodies/triggers and the canonical contract unchanged.

## Supabase Auth-schema privilege adaptation

Rollback verification found that the Test postgres operator cannot delegate Auth-schema USAGE to the new edit owner. The ineffective grant is removed. A private, postgres-owned, fixed-search-path SQL function returns only the existing `auth.uid()` context; EXECUTE is granted only to `mv2_edit`. It performs no writes, issues no permit and grants no access to Auth tables. Identity context alone remains insufficient: the media issuer first requires an independently authenticated session with media-editor membership and rejects both the finalizer owner and worker caller memberships. Broker validation of the seller remains an explicit trust dependency. No historical Auth/V1 function or trigger changes.
