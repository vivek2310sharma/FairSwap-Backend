# FairSwap Moderation V2 — Point 3 Approval Foundation

**Status:** Implementation handoff and design review only; no migration, hosted operation, worker deployment, provider call or activation authorized by this file.
**Owner:** Point 3 (Backend Approval), with separate CTO/integration ownership of shared configuration and CI.
**Authoritative source:** [MODERATION_V2_CONTRACT.md](MODERATION_V2_CONTRACT.md), especially §§3, 5–12. This plan is subordinate to that contract; any disagreement blocks implementation.
**Reviewed schema:** Source commit \`07b5b203ef718d4b2894498d883c8e42eb537ea3\` passed Backend independent CI/PG15 run 39145177360. A clean two-file handoff commit \`95d5e22ec5ce4211a1582f4b98be12f496d2411c\` has identical contract/test Git blob SHAs, based directly on approved main \`1de4e5fd1ec176000e56435a7c5de8aca49d1799\`.

## 1. Current evidence and immutable boundaries

1. V1 is authoritative today. Preserve \`public.listing_moderation_requests\`, \`public.listing_moderation_results\`, the V1 listing enqueue trigger, \`claim_moderation_batch\`, \`impl_finalize_moderation_result\`, existing manual staff approval/AAL2/revision checks, and \`process-listing-moderation\`. Do not edit historical migrations.
2. The original 58-file migration manifest, exact PostgreSQL baseline, unit allowlist, and network-blocking test setup are pinned by CI. The existing isolated database replay currently expects precisely those 58 migrations; simply appending a migration to that lane fails its intentional integrity checks.
3. Production's isolated release baseline and Test history differ; the operations record describes a scoped 52-version Production baseline. Never apply the whole 58-file source directory to hosted Production.
4. Backend exclusive deploy authority is **not verified** in \`docs/operations/DEPLOYMENT_OWNERSHIP.md\`. Neither a source commit nor successful CI authorizes a hosted release.
5. Web media writers and trusted image-processing placement are separate owners. Do not infer Supabase Storage supports irrevocable object lock. Until create-only sealed namespace enforcement is demonstrated across all relevant privileged writers and safe image sealing is verified, **V2 publication is disabled**.
6. Policy \`fairswap_moderation_v2.0.0\` contains the unchanged three FairSwap text rules and pinned \`omni-moderation-2024-09-26\` provider schema. India-specific Hindi/Hinglish fraud rules remain documented detection gaps, not part of this release.

## 2. Database topology — proposed implementation mapping, not yet an approved schema

Use a **separate private V2 namespace** (working name \`app_moderation_v2\`) for policy registry, durable requests, validation claims, preparation state, attempts, admission slots, checkpoints, result/idempotency records, sealed bundles and object identities. Keep V1 tables and V1 request IDs distinct. Final table names, key/index definitions and owners must be reviewed against actual deployed schema and local PG15 tests before any migration is committed.

Candidate logical tables / constraints:

| Logical store | Required authoritative properties |
| --- | --- |
| \`policy_registry\` | Exact contract/policy/evaluator build, pinned model/recipe, allowlisted statuses; no acceptance based only on evaluator-version regex. |
| \`requests\` | \`protocol_version=2\`, policy, listing ID/revision, generation ID, input-validation/preparation/evaluation lifecycle, persisted retry deadline; uniqueness per V2 generation and non-shadow active route. |
| \`validation_claims\` | Short provisional DB-issued attempt/token, expiry; exact title/description and scalar identity; no media dependency or publication capability. |
| \`bundles\` / \`objects\` | Append-only sealed media association, five unique object IDs per bundle, content digests, sizes/dimensions, paths retained **only inside private DB**, asset-version/recipe/retirement status; no cross-listing reuse. |
| \`snapshot_registry\` | DB-derived exact text digests, complete media manifest and snapshot digest, cover, revision/generation; immutable identity once claimed. |
| \`attempts\` / \`admission_slots\` | One claimed job per available DB-owned slot, exclusive lease/token, bounded attempts and call starts, expiry/circuit-breaker state; no preclaimed batches waiting for slots. |
| \`checkpoints\` | Unique (request, policy, snapshot, check ID, target) evidence, explicit completed/failed states and input digest; conflicting replay denied; flags never erased by retry. |
| \`decisions\` / \`side_effect_keys\` | Unique (request, attempt) canonical payload digest and replay response, single listing transition/audit/notification identity; append-only evidence. |

Every added table has a documented security owner, restrictive privileges and RLS. Prefer unexposed private schema plus qualified \`SECURITY DEFINER\` internals where unavoidable; service-only \`public\` RPC wrappers, if needed for PostgREST, must be \`SECURITY INVOKER\` with **EXECUTE revoked from PUBLIC/anon/authenticated** and explicitly granted only to service_role. Do not use user-editable JWT metadata for authorization. No direct client access to tokens, object paths, checkpoints or findings.

The V2 switches are distinct: \`moderation_v2_enabled\` defaults \`false\` (missing means false); mode \`disabled\` by default (other allowed values \`shadow\`, \`enforce\`; anything else denies). The enforce allowlist initially is empty. \`moderation_automation_enabled\` and its existing Vault veto are additional publication gates, not substitutes. **No live switch changes** are in this scope.

## 3. Reserved V2 RPC contracts, all service-only

- \`register_moderation_media_bundle_v2\`: atomically verify listing/media association, revision, source/recipe/object identities, five slots, immutable asset version, and replay equality before registration. No raw caller assertion substitutes for trusted sealer checks.
- \`claim_moderation_v2_input\`: claim text immediately after V2 request creation, before any image preparation. Require exact scalar freshness, short DB-owned lease, and deterministic field validation. Early \`input_validation\` finalization cannot publish.
- \`claim_moderation_v2\`: reserve free admission slot first; atomically claim **one** prepared request with registered snapshot under DB-owned policy/gate checks; return one opaque token/attempt and bounded authorized inputs.
- \`heartbeat_moderation_v2\`: renew only current unexpired lease within DB-owned upper bound and unchanged request/generation/gates.
- \`checkpoint_moderation_v2\`: validate exact Zod-compatible check shape, input binding and unique identity; accept identical replay, reject conflicting evidence; budget all provider starts.
- \`finalize_moderation_v2\`: lock listing → request → media/registry in stable order; validate trusted caller, lease or matching prior idempotency record, exact stored identity, gate, complete manifest, active policy and result. Early invalid-input and full evaluation follow separate fail-closed paths.
- \`get_moderation_v2_attempt\`: service-only read of sanitized recorded decision on ambiguous finalization response, without leaking claim tokens or personal content.

RPC response successes have exactly one approved decision: \`auto_approved\`, \`routed_to_admin\`, \`awaiting_retry\`, \`awaiting_media_processing\`, \`escalated_to_admin\`, \`rejected_invalid\`, \`superseded\`. Stable error codes follow normative §7. A matching \`(request_id,attempt_id,canonical_payload_digest)\` replay returns the recorded response **before** checking an expired lease or changed listing; a mismatched replay conflicts. SQL controls approval independently of TypeScript checks.

## 4. Controlled development slices

| Slice | Exclusive owner, files | Observable completion criteria |
| --- | --- | --- |
| A — CI forward lane | **CTO/integration only**: \`scripts/ci/**\`, \`.github/workflows/**\`, \`supabase/config.toml\` if needed | Leave historical 58-byte manifest and 93+103 unit allowlist intact; create a separate additive forward-migration PG15 test lane based on the frozen baseline. Require migration/version/hash accounting and explicit Test/Production base separation. Fail closed when proposed migrations are not included or unexpected migrations appear. |
| B — Private DB foundation | **Point 3**: CLI-generated new files in \`supabase/migrations/**\`; \`supabase/tests/moderation_v2_*.test.sql\` | Explicit V2 protocol/policy registry and private queue tables, restrictive grants/RLS, default-off gate + mode + empty allowlist. No routing change, cron, publication RPC or hosted write. |
| C — Early text validation | Point 3 migration + pgTAP tests | Invalid title/description produces only strict \`input_validation\` envelope with deterministic error codes and null-digest semantics; requires no media readiness; cannot approve. Stale revisions supersede. |
| D — Sealed registry / snapshot | Point 3 migration + pgTAP tests, then separately scoped Storage owner integration | Reject mutable/foreign/retired bundles and byte/hash mismatch. Include **all** attached media rows (uploading, processing, failed); exact manifest/cover/order; deterministic TS ↔ SQL hash fixtures. No live publishing while Storage immutability unproven. |
| E — Lease/checkpoint/admission | Point 3 migration, \`supabase/functions/_shared/listing-moderation-v2-worker.ts\`, \`src/__tests__/moderation-v2-worker.test.ts\` | DB-owned single-job claim/admission, lost-lease fencing, stable retry and checkpoint uniqueness, bounded provider-start reservations, fail-closed recovery; synthetic clock/concurrency tests. Provisional timings must not be treated as approved. |
| F — Atomic finalizer | Point 3 migration + pgTAP tests | Idempotent input/evaluation phases; exact checks and categories, DB-owned full snapshot and policy matching; stale/uncertain paths cannot publish. Approval attaches **registered sealed** paths and writes exactly one evidence/transition/side-effect record within one transaction. |
| G — Isolated Edge entry | Point 3: \`supabase/functions/process-listing-moderation-v2/index.ts\` and its \`deno.json\` | Secret/Vault authorization **before queue access**, no real provider credentials, one-attempt invocation, typed strict boundaries, synthetic mocked transport, bounded resources, no secret/content logging. Separate V1 entrypoint untouched. |
| H — Enqueue/gated routing | Point 3 forward migration, shared integration review | Under parent listing lock, V1 or V2 receives a revision in **enforce** mode, never both. Shadow is non-authoritative and cannot delay V1. Disabling V2 cannot replay a V2 generation into V1. All existing seller/Admin RPCs still operate. |
| I — Consumer/security/release | CTO/integration + authorized Web/Storage/privacy/release owners | All acceptance scenarios pass on disposable local DB; separate held-off hosted release review. Do not switch on V2 until immutable Storage protection, processor placement, privacy and Test/Production deployment owners approve. |

### Required concurrency and correctness observations

1. Lock order is listing → request → media/registry UUID order for every competing finalization, attachment and retirement path. Avoid SQL network I/O inside publication transaction.
2. Manifest preimage: compact JSON array with first element \`fairswap:v2:manifest_v1\`; snapshot preimage first element \`fairswap:v2:snapshot_v1\`. Hash byte-for-byte UTF-8 exact stored text and canonical array elements; **do not assume jsonb::text equals JSON.stringify**. Include two-text/eight-image cases and Unicode/escaping fixtures.
3. Check instances = eight text checks + two per registered media image (10–24 total); duplicate/extra/missing evidence is never a clean result. Image-only unsupported category must be \`not_applicable/null\`, not a false flag or zero score. Preserve prior positive flags when some checks fail.
4. A V2 auto approval requires eligible pending listing/revision, server-selected enforce route, approved policy/build, still-valid account/current policy/category, all media sealed/ready, complete pass evidence, existing automation+Vault checks and the distinct V2 gates. A flagged or incomplete result stays pending review or escalates; never auto reject from provider categories.
5. Retries and concurrency are DB-governed. The 120s lease, two slots, 240s attempt and related values in §8 are **provisional** pending runtime tests. Lease loss aborts further work; expired workers never commit late.
6. Early invalid-input cannot smuggle \`checks\`/\`snapshot\`; evaluation cannot omit \`snapshot\`. DB recomputes exact original text length/type and cannot accept provider failures as seller-invalid.
7. Admin manual moderation continues through versioned RPC, role/AAL2 and self-review restrictions; do not create an alternate privileged public approval endpoint.

## 5. Test and evidence gates (no hosted state)

- **C01–C04:** exact version/policy/check sets, category modality, out-of-order media identity.
- **C05–C10:** source mutation, five-slot sealing, immutable registry, full manifest including nonready media, canonical TS/SQL digest parity.
- **C11–C18:** V1/V2 isolation, disabled/shadow/enforce behaviour, stale generation, lease expiry, idempotent replay, Admin race and privilege/secret denial.
- **C19–C20:** characterize India scam gaps and log/retention privacy boundaries without changing the policy or uploading actual user content.
- **C21–C27:** client contract regressions, measured runtime feasibility, transaction rollback, exact environment migration plans, strict early-input phase, no native-image-runtime assumption.

All pgTAP mutation fixtures must run on an **isolated disposable PG15 environment**, never Test/Production. Add PG17 compatibility later only through reviewed integration lanes. Synthetic provider tests must block network and automatic environment loading. Preserve the already-pinned non-network setup byte hash and current V1 test expectations.

## 6. Required review artifacts before implementation promotion

- A migration-by-migration ownership map and dependency DAG; new names generated with \`supabase migration new <name>\` from a verified pinned CLI, not invented or retrofitted into the 58 historical files.
- Explicit service/RLS/grant tests proving anon/authenticated cannot claim, seal, checkpoint, finalize, read evidence, or publish, including forged Vault tokens and missing Vault.
- Reproducible TS/SQL canonical preimages and hashes; at least one/maximum eight images; Unicode, escaped text, nulls and media tie-break ordering.
- Race fixtures for seller edit, late uploading-media row, Admin accept/reject/remove, old V1 worker and expired claim; observed single authoritative decision and no duplicate notifications.
- GitHub CI evidence from the forward lane showing both old V1 baseline and new V2 tests, plus a separate PG15 transaction-rollback rehearsal.
- Recorded sign-offs from Web/Storage immutable namespace owner, image-processing runtime owner, privacy/legal owner and environment-scoped release operator **before any enablement**.

## 7. Strict stop conditions

Stop and seek CTO integration review if a proposed change touches V1 workers/functions, seller/Admin RPC shape, global CI, \`tsconfig.json\`, \`vitest.config.ts\`, package/lockfiles, \`supabase/config.toml\`, or shared migrations/trigger behaviour without an explicit serialized owner. Stop before touching any hosted project or real provider credentials. No feature gate is enabled by this document or by compiling a schema.

**Near-term next implementation:** the CTO/integration-owned additive local forward-migration CI lane (slice A), then a Point 3 **default-off private V2 foundation migration** (slice B). These can be independently reviewed without image processing or release credentials.