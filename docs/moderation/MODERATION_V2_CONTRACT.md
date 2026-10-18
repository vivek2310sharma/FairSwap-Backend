# FairSwap Moderation V2 Contract

Status: CORE ARCHITECTURE APPROVED; final specification submitted for CTO review.
Documentation/design only. Contract 2.0.0,
policy `fairswap_moderation_v2.0.0`. Prepared 18 October 2026 (Europe/Copenhagen).
Incorporates the final CTO decisions; activation prerequisites remain below. This document does
not authorize implementation, SQL execution, provider calls, deployment or rollout.

## 1. Provenance, authority and compatibility

Backend base: `e780fb8021e222462a3628ea828c381117cb1bb9` (verified remote main).
Web inspection: `a921341bfbb1900cdd3aa7d5380262caed806d73` (remote main;
read-only inspection, not a new extraction baseline).

Read AGENTS.md, docs/extraction/POINT1_BASELINE.md,
docs/operations/DEPLOYMENT_OWNERSHIP.md,
docs/operations/POINT1_SOURCE_BOUNDARY_AND_OWNER_ACTION.md and
docs/operations/BACKEND_ONLY_RELEASE_CUTOVER.md. Historical stage restrictions
conflict with later accepted records; the latest human request authorizes only
this design revision, documentation branch/commit and review PR, with no automatic
merge. Current records report V1 intentionally enabled; no hosted setting
was queried or changed here. Exclusive Backend deployment authority is incomplete.

Preserve both seller_submit_listing overloads, existing application RPC signatures,
results/errors, listing statuses, RLS, ownership/account/policy checks, staff AAL2,
self-review prohibitions, PT409 conflicts, Vault dispatch authentication, private
Storage and Web/iOS/Android/Admin contracts. Preserve category publication guards.
No standalone server. Historical migrations/tests remain immutable; any future
database changes use separately approved environment-specific forward migrations.

## 2. Current media implementation: inspected evidence

At the pinned Web ref:

- `src/app/api/listings/[id]/media/route.ts` accepts one image, checks authorization,
  eight-photo/5-MiB limits and JPEG/PNG/WebP magic bytes, inserts a fresh media UUID,
  then writes `<listing>/<media>/original.<ext>`, thumb.webp, medium.webp and
  large.webp. **All four Storage uploads use service-role and upsert=true.** A
  normal new upload has new keys, but old keys are not inherently immutable.
- `src/lib/media/processor.ts` uses Sharp, orientation correction, 64-megapixel and
  8000-per-axis bounds. Derivatives strip metadata. Thumbnail is a 200px crop;
  medium/large preserve the frame at 800/1400 maximum edge.
- `[mediaId]/[size]/route.ts` resolves paths from listing_media and issues signed
  URLs under existing visibility/authorization. Public derivatives require ready
  media; originals remain private. Paths can change without changing HTTP shapes.
- No inspected route exposes a same-media replacement API. Privileged upsert or
  reprocessing can nevertheless replace an existing object's bytes. This is source
  inspection, not evidence of a hosted incident or an exhaustive writer inventory.

Backend `20260914000006_create_listing_media.sql` stores paths, processing state
and dimensions, without an authoritative content digest/version.
`20260914000007_create_storage_buckets_and_policies.sql` makes both buckets private,
with server-mediated writes. Later Admin read policies do not confer ordinary
write access. `20261012120000_post_ad_current_base_compatibility.sql` retains
parent-before-media locking and family-specific lifecycle restrictions in processing
completion. Existing readiness/delete/cover/reorder revision invalidation does not
observe an independent same-key Storage overwrite.

UUID/path/timestamp/ETag alone is not content identity. Hashing again immediately
before SQL publication leaves a race between Storage and SQL. Supabase documents
[upsert overwrites](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
and [service-key RLS bypass](https://supabase.com/docs/guides/storage/security/access-control).
Neither private buckets nor ordinary RLS constrain a service-role writer.

## 3. Image identity: seal, evaluate, atomically attach

### 3.1 Sealed bundles

For V2, a trusted sealer reads each ready source through a fixed authorized Storage
origin, hashes those exact fetched bytes, validates bounded decode, applies
orientation and strips EXIF/GPS/other metadata. It emits a full-frame canonical
WebP and thumb/medium/large derivatives from the same decoded frame, with pinned
codec/toolchain recipe `seal_v1`. Reject animation/multipage content; never
silently inspect only a first frame. No generative transformation, OCR, translation,
crop or downscale of the canonical provider image. If the canonical image cannot
fit the approved 5-MiB/8000-axis/64-megapixel bounds, route to Admin. Public
derivatives retain existing dimensions and crop behavior.

Safe image-processing placement is a publication-activation prerequisite. Existing
Sharp runs in Web's Node runtime; the Supabase Edge worker MUST NOT assume Sharp
or native Node image dependencies can execute in Edge Functions. Point 2 owns the
sealing interface/recipe, not an unapproved runtime deployment. Establish a separately
approved compatible trusted processing runtime, or prove a bounded metadata-safe
decoder/encoder usable in the chosen runtime. Web changes are NOT authorized.
Until placement and enforcement are verified, provider workers consume mocked or
previously registered synthetic fixture bundles only; no live provider work in this phase.

Create a random asset_version UUID and new content-addressed keys:
`<listing>/<media>/v2/<asset_version>/<sha256>/<variant>.<ext>`.
Preserve an exact sealed copy of the raw source for the existing private original
download contract (original jpg/png/webp). The separate metadata-stripped canonical
provider input is WebP and never replaces the raw original. These two objects
remain private in listing-originals; three rendered WebP variants remain in
listing-derivatives. There are five registered objects per bundle. Original SHA-256
must equal source_sha256. Write with upsert=false, read back and verify SHA-256,
then register the bundle with an additive service-only RPC. Registry binds listing,
media, source hash, recipe, each object's ID/key/hash/bytes/dimensions and creation
time. Entries are append-only; explicit retirement invalidates their evidence.
No key reuse, overwrite or move onto a sealed key.

OpenAI receives **the exact registered canonical bytes** from a verified in-memory
buffer as an inline image data URL, not a signed or mutable source URL. Every
served derivative must come from the trusted recipe applied to that canonical
frame, never an independently uploaded variant. Hashes bind bytes; trusted sealer
execution establishes lineage. Full-frame moderation does not guarantee tiny-text
OCR or detect every prohibited item/fraud pattern; do not claim those capabilities.

Finalization compares the live source manifest and atomically selects registered
sealed object paths in the existing listing_media columns while publishing and
recording evidence. Delivery URLs and application RPC/response shapes stay intact.
Publishing mutable legacy paths while merely retaining a snapshot copy is forbidden.
Attachment must be an internal operation with unchanged seller/review revision
semantics, tested against all current triggers. Do not disable triggers; any narrowly
scoped internal permit needs separate review. Source edits while evaluation runs
must supersede or publish the evaluated immutable bundle, never altered bytes.

### 3.2 Enforceable write boundary: activation blocker

upsert=false in one client is insufficient. Before V2 publication:

1. Inventory Web, processing, cleanup, Admin/manual and external privileged writers.
   Existing Web writes legacy keys; it must never write the sealed namespace.
2. Enforce create-only sealed objects across all ordinary privileged writers using
   a validated Storage/object-metadata enforcement boundary or independently
   enforced write-proxy/credential boundary. Verify whether the deployed Storage
   version safely supports the former before choosing it. This is a blocking
   implementation spike, not an assertion that Supabase provides object lock.
   The provider worker is read-only; the sealer cannot overwrite/delete bundles.
3. Retirement/deletion locks the parent listing, invalidates pending evidence or
   withdraws active visibility BEFORE object deletion. Cleanup must honor this.
4. SQL does not fetch/hash network content inside its transaction. It validates
   registered immutable identities plus the current complete manifest under locks.

A privileged operator capable of disabling enforcement remains a trusted
administrative boundary. If the boundary cannot be enforced without separately
approved Web/Storage work, V2 remains non-publishing; mocks/shadow design do not
waive this gate. No Web or Storage enforcement changes are authorized here.

### 3.3 Complete manifest and canonicalization

Under the parent listing lock, preparation includes ALL attached media rows,
including uploading/processing/failed rows. Freeze membership, order, cover,
source paths/status, hashes and sealed bundle identities. One to eight images,
all ready/sealed, and a member cover ID are required for an evaluable snapshot.
Preparation waits for processing; it must never drop unfinished images. Failed or
unsupported media routes to Admin. Newly uploading rows at publication invalidate
the snapshot even if the historical insert trigger does not increment revision.

Snapshot includes listing/revision/generation, exact text digests, ordered media
IDs, display_order, cover, source-path/state/hash, recipe, asset_version, and all
five sealed object IDs/hashes/sizes/dimensions. DB owns the internal source
manifest. Worker results carry digests/opaque object IDs, not paths. DB recomputes
and compares the complete expected snapshot, not just caller-provided hashes.

SHA-256 hashes UTF-8 bytes; text hashes exact stored Unicode without implicit
normalization. Existing validation may trim without changing identity. Manifest
and snapshot preimages are JSON arrays with fixed element order, lowercase
UUID/hex, integer numbers, explicit nulls and no whitespace, domain-prefixed
`fairswap:v2:manifest_v1` / `fairswap:v2:snapshot_v1`. Media order is ascending
(display_order, media_id); never hash unordered JSON objects. Publish exact
TS/SQL preimage fixtures before integration. Text/media/cover/order changes
supersede old generations. No cross-listing or cross-policy evidence reuse.

Exact preimage tuples (compact JSON encoding, no trailing newline; domain is
the first array element, not an ambiguous byte concatenation):

```text
Object = [object_id, sha256, bytes, width, height]
Media = [media_id, display_order, processing_status,
         original_source_path, thumbnail_source_path, medium_source_path,
         large_source_path, source_sha256, asset_version, "seal_v1",
         Object(original), Object(canonical), Object(thumb), Object(medium), Object(large)]
Manifest = ["fairswap:v2:manifest_v1", listing_id, cover_media_id,
            [Media in ascending (display_order, media_id) order]]
Snapshot = ["fairswap:v2:snapshot_v1", "2.0.0", policy_version,
            listing_id, listing_revision, generation_id,
            title_sha256, description_sha256, media_manifest_sha256]
```

Source paths are exact DB strings, escaped as JSON without Unicode normalization.
These source-manifest fields are private preparation/DB data, never provider data.
Manifest digest hashes the Manifest tuple; snapshot digest hashes Snapshot.
UUIDs/hex are lowercase. SQL must match JSON.stringify string escaping and compact
encoding; jsonb::text must not be assumed byte-equivalent.

## 4. Mandatory checks and exact modality coverage

Required instances: each FairSwap text check below on EACH title/description;
OpenAI text separately on EACH field; integrity and OpenAI image on EACH media_id.
No duplicate, extra, unrecognized or silently skipped instance.

| Check ID | Targets | Meaning |
| --- | --- | --- |
| rule_prohibited_item_wording | title, description | Existing V1 rule, unchanged |
| rule_shortened_link | title, description | Existing V1 rule, unchanged |
| rule_payment_before_viewing | title, description | Existing V1 rule, unchanged |
| openai_text_v2 | title, description | One text-only request per field; 13 categories |
| image_integrity_v2 | each image | Supported bounded decode, ownership, seal, exact hash/lineage |
| openai_image_v2 | each image | One image-only request on canonical bytes; six supported categories |

| Category | Text | Image |
| --- | --- | --- |
| harassment | required | not_applicable |
| harassment/threatening | required | not_applicable |
| hate | required | not_applicable |
| hate/threatening | required | not_applicable |
| illicit | required | not_applicable |
| illicit/violent | required | not_applicable |
| sexual/minors | required | not_applicable |
| sexual | required | required |
| self-harm | required | required |
| self-harm/intent | required | required |
| self-harm/instructions | required | required |
| violence | required | required |
| violence/graphic | required | required |

not_applicable means the pinned model does not support that category/modality
pair. It is neither a check pass nor a failure, contributes nothing to required
coverage, and uses null flag/score even when raw response contains false/zero.
Missing data on a REQUIRED pair is PROVIDER_SCHEMA failure. Unsupported media
(format/animation/decode/size) is UNSUPPORTED_MEDIA integrity failure with manual
escalation, never not_applicable. Timeout/HTTP/schema failure is failed execution.

CTO-approved initial pinned model: `omni-moderation-2024-09-26`. Preserve the
verified 13-text/six-image category definitions above. Account availability still
requires a later authorized readiness check; no live provider calls or credentials
in this phase. No latest-alias fallback.
One input per request avoids multimodal aggregate attribution ambiguity. Any
applicable category flag routes to review; policy 2.0.0 uses no custom score
thresholds. Scores are review evidence only. Contradictory aggregate flag or
unexpected support/model changes are schema failures until reviewed.
[OpenAI guide](https://developers.openai.com/api/docs/guides/moderation),
[model IDs/API schema](https://developers.openai.com/api/reference/resources/moderations/methods/create).

### 4.1 India scam coverage gaps and future synthetic fixtures

This release has exactly the three existing FairSwap rules, unchanged. No new
India fraud rule, signal identifier or mandatory check is included. Hindi/Hinglish
and India-specific scams below are documented coverage gaps, not promises of
current detection. Neither the three rules nor OpenAI harm categories reliably
detect these scams. Do not change historical rules or label missed scam fixtures
as regressions requiring business-logic edits in this release.

A separately scoped future enhancement may evaluate these human-labelled intents,
with frozen dictionaries, transliteration, clause/negation and quote handling.
It requires its own policy/version and approval. It is not a release dependency
for implementing the currently approved three-rule V2 contract.

| Synthetic fixture | Future-review intent / coverage gap (not current expected detection) |
| --- | --- |
| देखने से पहले ₹500 टोकन UPI से भेजें | ADVANCE_VIEWING |
| Pehle 500 token UPI karo, phir bike dekh lena | ADVANCE_VIEWING |
| Paise receive karne ke liye QR scan karke UPI PIN dalo | QR_RECEIVE, OTP_PIN |
| अपना OTP और UPI PIN मुझे भेजें | OTP_PIN |
| Main army officer hoon, delivery se pehle refundable courier fee bhejo | IMPERSONATION_FEE |
| OTP ya UPI PIN kabhi share mat karo | none; safety advice |
| Dekhne se pehle koi advance mat bhejna | none; negation |
| UPI accepted after inspection; cash bhi chalega | none |
| Army-green bicycle, local pickup | none; no impersonation solicitation |
| Heroine-themed poster and glue gun for sale | Preserve V1 negative controls |

Include Hindi, Hinglish and English, mixed scripts, ₹/Rs/INR, transliterations,
Unicode/zero-width evasion, punctuation, benign quotes and adversarial negation
scope. Any future matching normalization must be versioned and must not change source hashes.
Use human-labelled false-positive/missed-scam gap sets; language identity itself must
never cause review/rejection. No claim of complete fraud protection or OCR.

Documentation characterization at the pinned Backend base: all ten table entries
returned no_review_flags from the unchanged three-rule evaluator with a synthetic
valid title. In particular, the first five risky examples were not flagged. This
records current limitations, not successful scam detection or provider acceptance.
Future enhancement tests must distinguish desired labels from current outputs.

## 5. Normative TypeScript/Zod evaluator result

This is the proposed exact wire schema (Zod 3.24.2), embedded documentation only.
Database validation independently enforces all refinements, reason allowlists,
and equality to its registered snapshot. Schema validation does not prove digest
preimages, Storage immutability or provider truthfulness. Trusted worker identity
is required. Claim tokens are supplied separately and never persisted as findings.

```ts
import { z } from "zod";
export const POLICY = "fairswap_moderation_v2.0.0" as const;
export const MODEL = "omni-moderation-2024-09-26" as const;
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const UUID = z.string().uuid().regex(/^[0-9a-f-]+$/);
export const FS_IDS = ["rule_prohibited_item_wording", "rule_shortened_link",
  "rule_payment_before_viewing"] as const;
export const CHECK_IDS = [...FS_IDS, "openai_text_v2",
  "image_integrity_v2", "openai_image_v2"] as const;
export const CATEGORIES = ["harassment", "harassment/threatening", "hate",
  "hate/threatening", "illicit", "illicit/violent", "sexual", "sexual/minors",
  "self-harm", "self-harm/intent", "self-harm/instructions", "violence",
  "violence/graphic"] as const;
export const IMAGE_CATEGORIES: readonly string[] = ["sexual", "self-harm",
  "self-harm/intent", "self-harm/instructions", "violence", "violence/graphic"];
const Reason = z.enum(["PROHIBITED_WORDING", "SHORTENED_LINK", "PAYMENT_BEFORE_VIEWING",
  "PROVIDER_FLAG",
  "UNSUPPORTED_MEDIA", "DIGEST_MISMATCH", "SEAL_INVALID", "TIMEOUT", "RATE_LIMIT",
  "PROVIDER_5XX", "TRANSPORT", "PROVIDER_SCHEMA", "PROVIDER_AUTH", "PROVIDER_INPUT",
  "LEASE_LOST"]);
const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), field: z.enum(["title", "description"]) }).strict(),
  z.object({ kind: z.literal("image"), media_id: UUID }).strict(),
]);
const ObjectIdentity = z.object({
  object_id: UUID, sha256: Hash, bytes: z.number().int().min(1).max(5242880),
  width: z.number().int().min(1).max(8000), height: z.number().int().min(1).max(8000),
}).strict();
const Media = z.object({
  media_id: UUID, asset_version: UUID, display_order: z.number().int().nonnegative(),
  source_sha256: Hash, recipe: z.literal("seal_v1"), original: ObjectIdentity,
  canonical: ObjectIdentity,
  thumb: ObjectIdentity, medium: ObjectIdentity, large: ObjectIdentity,
}).strict();
export const SnapshotV2Schema = z.object({
  listing_id: UUID, listing_revision: z.number().int().nonnegative(), generation_id: UUID,
  canonicalization: z.literal("snapshot_v1"), title_sha256: Hash,
  description_sha256: Hash, media_manifest_sha256: Hash, snapshot_sha256: Hash,
  cover_media_id: UUID, media: z.array(Media).min(1).max(8),
}).strict();
const Category = z.object({ category: z.enum(CATEGORIES),
  applicability: z.enum(["evaluated", "not_applicable"]),
  flagged: z.boolean().nullable(), score: z.number().min(0).max(1).nullable(),
}).strict();
const Provider = z.object({
  name: z.literal("openai"), requested_model: z.literal(MODEL), returned_model: z.literal(MODEL),
  response_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable(),
  flagged: z.boolean(), categories: z.array(Category).length(13),
}).strict();
const Check = z.object({
  check_id: z.enum(CHECK_IDS), target: Target, input_sha256: Hash,
  state: z.enum(["passed", "flagged", "failed"]), reason_codes: z.array(Reason).max(20),
  retryable: z.boolean(), provider: Provider.nullable(),
}).strict();
const localFlags: Record<string, readonly string[]> = {
  rule_prohibited_item_wording: ["PROHIBITED_WORDING"],
  rule_shortened_link: ["SHORTENED_LINK"],
  rule_payment_before_viewing: ["PAYMENT_BEFORE_VIEWING"],
};
const transient: readonly string[] = ["TIMEOUT", "RATE_LIMIT", "PROVIDER_5XX", "TRANSPORT", "PROVIDER_SCHEMA"];
const failures: readonly string[] = [...transient, "UNSUPPORTED_MEDIA", "DIGEST_MISMATCH",
  "SEAL_INVALID", "PROVIDER_AUTH", "PROVIDER_INPUT", "LEASE_LOST"];
const Identity = {
  contract_version: z.literal("2.0.0"), policy_version: z.literal(POLICY),
  evaluator_version: z.string().regex(/^v2\.[0-9]+\.[0-9]+$/),
  request_id: UUID, attempt_id: UUID, evaluated_at: z.string().datetime({ offset: true }),
};
export const EarlyInvalidResultV2Schema = z.object({
  ...Identity, phase: z.literal("input_validation"), outcome: z.literal("invalid_input"),
  listing_id: UUID, listing_revision: z.number().int().nonnegative(), generation_id: UUID,
  title_sha256: Hash.nullable(), description_sha256: Hash.nullable(),
  validation_errors: z.array(z.object({ field: z.enum(["title", "description"]),
    code: z.enum(["TYPE", "TOO_SHORT", "TOO_LONG"]) }).strict()).min(1).max(2),
}).strict();
export const EvaluationResultV2Schema = z.object({
  ...Identity, phase: z.literal("evaluation"), snapshot: SnapshotV2Schema,
  checks: z.array(Check).max(24),
  outcome: z.enum(["no_review_flags", "needs_review", "checks_incomplete"]),
}).strict();
export const ModerationResultV2Schema = z.discriminatedUnion("phase", [
  EarlyInvalidResultV2Schema, EvaluationResultV2Schema,
]).superRefine((r, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (r.phase === "input_validation") {
    if (new Set(r.validation_errors.map(e => e.field)).size !== r.validation_errors.length) bad("DUPLICATE_FIELD_ERROR");
    for (const e of r.validation_errors) {
      const digest = e.field === "title" ? r.title_sha256 : r.description_sha256;
      if ((e.code === "TYPE") !== (digest === null)) bad("VALIDATION_DIGEST_BINDING");
    }
    return;
  }
  const media = new Map(r.snapshot.media.map(m => [m.media_id, m]));
  if (media.size !== r.snapshot.media.length || !media.has(r.snapshot.cover_media_id)) bad("MEDIA_MEMBERSHIP");
  const sorted = [...r.snapshot.media].sort((a, b) => a.display_order - b.display_order
    || (a.media_id < b.media_id ? -1 : a.media_id > b.media_id ? 1 : 0));
  if (sorted.some((m, i) => m.media_id !== r.snapshot.media[i].media_id)) bad("MEDIA_ORDER");
  for (const m of r.snapshot.media) if (m.original.sha256 !== m.source_sha256) bad("ORIGINAL_BINDING");
  const objects = r.snapshot.media.flatMap(m => [m.original, m.canonical, m.thumb, m.medium, m.large]);
  if (new Set(objects.map(o => o.object_id)).size !== objects.length) bad("OBJECT_REUSE");
  const expected = new Set<string>();
  for (const field of ["title", "description"] as const)
    for (const id of [...FS_IDS, "openai_text_v2"]) expected.add(`${id}:text:${field}`);
  for (const id of media.keys()) for (const check of ["image_integrity_v2", "openai_image_v2"])
    expected.add(`${check}:image:${id}`);
  const seen = new Set<string>();
  for (const c of r.checks) {
    const t = c.target;
    const key = `${c.check_id}:${t.kind}:${t.kind === "text" ? t.field : t.media_id}`;
    if (!expected.has(key) || seen.has(key)) bad("UNEXPECTED_OR_DUPLICATE_CHECK");
    seen.add(key);
    const digest = t.kind === "text"
      ? (t.field === "title" ? r.snapshot.title_sha256 : r.snapshot.description_sha256)
      : media.get(t.media_id)?.canonical.sha256;
    if (c.input_sha256 !== digest) bad("INPUT_BINDING");
    if (new Set(c.reason_codes).size !== c.reason_codes.length) bad("DUPLICATE_REASON");
    if (c.state === "passed" && (c.retryable || c.reason_codes.length)) bad("PASS_WITH_ERROR");
    if (c.state !== "passed" && !c.reason_codes.length) bad("MISSING_REASON");
    if (c.state !== "failed" && c.retryable) bad("INVALID_RETRY");
    if (c.retryable && !c.reason_codes.every(x => transient.includes(x) || x === "PROVIDER_FLAG")) bad("NONRETRYABLE_REASON");
    const isProvider = c.check_id === "openai_text_v2" || c.check_id === "openai_image_v2";
    if (!isProvider && c.provider !== null) bad("LOCAL_PROVIDER_DATA");
    if (isProvider && c.state !== "failed" && c.provider === null) bad("MISSING_PROVIDER");
    const allowedFlags = isProvider ? ["PROVIDER_FLAG"] : (localFlags[c.check_id] ?? []);
    if (c.state === "flagged" && !c.reason_codes.every(x => allowedFlags.includes(x))) bad("INVALID_FLAG_REASON");
    if (c.state === "failed" && (!c.reason_codes.some(x => failures.includes(x))
      || !c.reason_codes.every(x => failures.includes(x) || allowedFlags.includes(x)))) bad("INVALID_FAILURE_REASON");
    if (c.provider) {
      const cats = c.provider.categories;
      if (new Set(cats.map(x => x.category)).size !== 13) bad("CATEGORY_MEMBERSHIP");
      for (const cat of cats) {
        const applies = t.kind === "text" || IMAGE_CATEGORIES.includes(cat.category);
        if (applies && (cat.applicability !== "evaluated" || cat.flagged === null || cat.score === null)) bad("MISSING_COVERAGE");
        if (!applies && (cat.applicability !== "not_applicable" || cat.flagged !== null || cat.score !== null)) bad("FALSE_IMAGE_COVERAGE");
      }
      const flagged = cats.some(x => x.applicability === "evaluated" && x.flagged === true);
      if (c.provider.flagged !== flagged) bad("PROVIDER_FLAG_CONFLICT");
      if (c.state !== "failed" && (c.state === "flagged") !== flagged) bad("CHECK_FLAG_CONFLICT");
    }
  }
  const full = seen.size === expected.size;
  const failed = r.checks.some(c => c.state === "failed");
  const flagged = r.checks.some(c => c.state === "flagged");
  const outcome = !full || failed
    ? "checks_incomplete" : flagged ? "needs_review" : "no_review_flags";
  if (r.outcome !== outcome) bad("OUTCOME_CONFLICT");
});
export type ModerationResultV2 = z.infer<typeof ModerationResultV2Schema>;
export type SnapshotV2 = z.infer<typeof SnapshotV2Schema>;
```

There are eight text instances plus two per image: 10–24. Complete evaluations
require the strict sealed snapshot and exact check coverage; missing checks are
allowed only for checks_incomplete. Unparseable provider responses use provider=null
and sanitized failure codes, never fabricated all-zero evidence. Retain valid
flags already collected; incomplete takes precedence.

Early invalid input has a separate strict phase, input_validation: scalar request/
listing/revision/generation identity and deterministic field errors, with NO snapshot,
media, checks or provider fields. No sealed image is needed or fabricated. A string
field's digest hashes its exact original bytes; null denotes missing/non-string
input. At most one deterministic error per field (TYPE before length); title
trimmed length is 3–150 and description 10–5000. The DB independently recomputes
validation against the request's exact text and current listing revision/generation.
Provider failures can never create field validation errors. The early phase can
only use existing invalid-text correction semantics or supersede on stale identity;
it can NEVER approve/publish or serve as a weaker evaluation envelope.

Validate text immediately after V2 request creation, before sealing/preparation or
provider dispatch. Use a short DB-owned validation claim/token and the same atomic
idempotency/lease checks; its provisional lease does not require media readiness.
Text-valid requests then enter preparation and evaluation. Other preparation
failures use the service-only preparation workflow, not fake media IDs. Never
weaken SnapshotV2Schema or make the evaluation snapshot optional to handle errors.

## 6. V1/V2 coexistence and rollout gates

Existing/null-version requests remain V1 with prototype_v0.1.1, title_description,
three rules, existing retries and finalizer behavior. No rewriting/backfill of
V1 requests or synthesized V2 passes. The server, never seller/provider, chooses
protocol at request creation.

Use a disjoint V2 queue with immutable protocol_version=2 and explicit policy_version.
The old claim/finalizer cannot address these request IDs. Enqueue routing chooses
exactly one live automatic protocol per listing/revision, atomically under listing
lock. All retry/recovery paths retain stored policy/generation. New revisions may
follow approved routing, but an existing V2 generation can never downgrade to V1.

Proposed separate gate `moderation_v2_enabled` defaults false (missing also false).
It gates V2 dispatch and publication; finalization rechecks under lock. Additional
server-owned mode: disabled (default), shadow, enforce. Shadow has a disjoint
non-authoritative namespace and cannot block/change V1 or publish. Shadow provider
calls still require separate privacy/operational approval. Enforce routes only a
server-owned allowlist; unknown mode fails closed. No configuration is introduced
or changed in this task.

Gate=true is required for either shadow or enforce activity; mode determines
authority. A policy registry pins approved evaluator build identifiers as well as
the model/recipe. A syntactically valid evaluator_version is insufficient unless
it is approved for the request's policy.

Automatic V2 publication ALSO requires existing moderation_automation_enabled and
its Vault veto to permit automation. Do not change/reuse the V1 switch as the V2
gate. Turning V2 off prevents new work/publication; pending V2 generations remain
unpublished and route to Admin after bounded wait, never replay as V1. Previously
published listings and all existing V1 settings are unchanged. Activation/rollback
each require separate reviewed release authorization.

## 7. Additive Supabase internal contracts

Proposed names below are reserved for future service-only interfaces. Preserve
Vault verification BEFORE queue access; deny PUBLIC/anon/authenticated execution.
Use least privilege, empty definer search_path, qualified objects and RLS for
exposed tables. Do not expand application permissions or expose storage/lease data.

| Proposed RPC | Required inputs/behavior |
| --- | --- |
| register_moderation_media_bundle_v2 | Expected listing/media/revision/source manifest plus verified bundle; idempotent asset_version; conflict on changed payload |
| claim_moderation_v2_input | Short DB-owned validation claim on scalar request/listing/revision/generation and exact text; no media/snapshot prerequisite; issue token/attempt/expiry, never publish |
| claim_moderation_v2 | One evaluation job per reserved free slot, no batch; provisional DB-fixed 120s lease; returns request/attempt IDs, policy/generation/snapshot, transient text, claim_token/expiry, attempt_count |
| heartbeat_moderation_v2 | request_id/attempt_id/claim_token; only current unexpired lease and unchanged generation/gate; provisional ceiling attempt start+300s |
| checkpoint_moderation_v2 | request/attempt/token plus validated check; unique request/policy/snapshot/target/check identity; reject conflicting evidence |
| finalize_moderation_v2 | request/attempt/token plus discriminated result; early phase validates exact text/scalar freshness without media and cannot publish; evaluation phase validates full manifest/coverage/reasons/eligibility before atomic attachment/publication |
| get_moderation_v2_attempt | Recovery lookup by request/attempt, returns recorded decision without secrets; used after ambiguous commit response |

Input validation precedes preparation/sealing, which precedes provider claim. Full internal evaluation claim schema must
include DB-owned source manifest/object refs needed for authorized reads, but no
paths leak to provider/public findings. Preparation has a 15-minute total deadline
from first pending-media observation, then escalates without using provider retries.

Finalization lock order: parent listing, request, media/registry in stable UUID order.
The early input_validation branch stops at listing/request locks, independently
checks the field errors and scalar freshness, then records rejected_invalid or
superseded without reading/sealing media. The following media requirements apply
only to the evaluation branch; no early phase can enter its publication path.
All competing attachment/retirement paths lock the same parent. Recheck association,
clock/lease after lock acquisition, listing status/revision, exact text, complete
live source manifest including non-ready rows, cover/order and registered bundles.
Stale evidence supersedes; never publishes or auto-rejects. Recheck existing
account/current-policy/category/required-field and family publication eligibility.
Uncertainty leaves pending review; never restore an unversioned approval bypass.

Response: success=true with one decision from auto_approved/routed_to_admin/
awaiting_retry/awaiting_media_processing/escalated_to_admin/rejected_invalid/
superseded, optional next_attempt_at; or success=false with stable error from
UNSUPPORTED_POLICY/INVALID_RESULT/SNAPSHOT_MISMATCH/LEASE_TOKEN_MISMATCH/
LEASE_EXPIRED/REQUEST_NOT_FOUND/IDEMPOTENCY_CONFLICT. Application errors stay intact.

Idempotency key is (request_id, attempt_id), bound to protocol/policy and canonical
result payload digest. A matching completed replay returns its recorded response
BEFORE live lease/status checks; changed payload conflicts. Unique result/audit/
side-effect keys prevent duplicate publication/email effects. Transaction failure
rolls back all attachment/status/evidence effects. Lost response: lookup then replay
finalization, not another provider call. SQL cannot authenticate provider truth:
trusted-worker identity plus immutable inputs is the trust boundary, while SQL
independently rejects structurally incomplete/forged registry evidence.

## 8. Execution, retries, deadlines and Admin escalation

V1 worker remains untouched. V2 has a separate handler/core, not a sequential
ten-job batch holding 60s leases.

ALL invocation, lease, heartbeat, admission/concurrency, timeout and preparation
values below are PROVISIONAL feasibility candidates, not approved runtime limits.
DB ownership, bounded retries, cancellation and fail-closed behavior are invariant.
Before activation, synthetic/mocked runtime feasibility tests must establish safe
limits for the selected processor and Edge runtime, then freeze them in a reviewed
policy/configuration change. No live provider calls, real user data or credentials
are authorized in this phase. Scalar validation claims also require a measured
short lease; no image work runs while that claim is held.

| Limit | Provisional candidate (requires feasibility validation) |
| --- | --- |
| Active attempts | One per invocation; global cap two via DB-owned expiring admission slots |
| Provider concurrency | Two HTTP calls per active attempt, maximum four globally |
| Claim | Exactly one job after reserving a free slot; never preclaim waiting batches |
| Lease | 120s; heartbeat every 30s; renewal ceiling attempt start+300s |
| Attempt | 240s total; cancel provider work at 210s, reserve 30s for persistence/finalization |
| Provider call | 15s total including connection/read; one HTTP attempt; SDK automatic retries off |
| Storage read | 10s total and streamed 5-MiB cap per object; bounded memory |
| Queue attempts | Maximum three per generation, persisted by DB |
| Retry scheduling | Base 10s after attempt one, 20s after attempt two, plus 0–5s DB jitter |
| Retry-After | Respect later of base and valid provider delay up to 15min; longer delay escalates without early retry |
| Preparation | Separate 15min budget; does not consume provider attempts |
| Invocation | One listing attempt then return; next dispatch handles subsequent work |

Illustration using these provisional values: two text plus eight images = ten provider inputs, five 15s waves at concurrency
two (75s), leaving storage/DB headroom within the bounded attempt. This is a
deadline calculation, not a latency promise. Validate actual deployed Edge
wall-time/memory/cancellation before activation; heartbeats cannot extend platform
limits. If unsuitable, use separately reviewed durable per-check jobs or lower
budgets, never silently increase a limit.

On heartbeat failure/lease loss, cancel calls, stop new work and forbid stale
finalization. DB recovery releases slots and records abandonment, with one attempt
increment per claim. Checkpoints may be reused only within the SAME request,
policy, snapshot and verified input digest. Failed checks rerun; flagged checks
are never retried merely to seek clean output. Calls are at-least-once after a
crash, not provider exactly-once. Persist call-start reservations before sending;
maximum three starts per check across a generation, including ambiguous crashes.

For the provisional 15s deadline, never start with less than 20s remaining on BOTH the lease and
provider-work budget; renew first or stop. This exceeds the 15s call deadline and
prevents a recovered admission slot from overlapping calls started at lease end.
The runtime must demonstrably abort calls on deadline; recovery waits through the
recorded latest call deadline if cancellation cannot be confirmed.

Retry TIMEOUT/RATE_LIMIT/PROVIDER_5XX/TRANSPORT within budget. PROVIDER_SCHEMA
permits at most one additional queue attempt. PROVIDER_AUTH/PROVIDER_INPUT/
UNSUPPORTED_MEDIA/DIGEST_MISMATCH/SEAL_INVALID escalate immediately. LEASE_LOST
uses DB recovery only. Authentication/config errors open a shared circuit breaker
before more provider claims; operator resolution requires separate authorization.

Nonretryable/exhausted failures retain flags, route to Admin and remain pending_review.
Fully completed flagged evidence also routes to Admin, without automatic rejection.
Only deterministic invalid text uses existing seller-correction semantics. Manual
review retains existing authorization/AAL2/revision/status safeguards; it never
fabricates provider passes.

## 9. Privacy, security and India-first review

- Run local checks on exact text. Provider gets only one title/description field,
  never seller/account IDs, private location columns, contact columns, storage
  paths, original filenames, credentials or internal listing/request identifiers.
  Text itself may contain personal data; it is not anonymous. Policy 2.0.0 sends
  the exact field, without silent redaction that could conceal scam context.
- Send metadata-stripped canonical images only. Faces/plates/contacts/identity
  documents/children may remain visible: no face recognition/identity inference.
  No raw text/image/inline URL/signed URL/error body in logs. Allowlist codes,
  durations and opaque attempts; no user-linked content hashes in telemetry.
- Provider keys remain server-side, separately provisioned only after approval.
  Fixed outbound origins/TLS, no redirects or user URLs. No keys needed for mocks.
  Admin sees authorized sanitized findings; seller response shapes remain intact.
  Evidence/provider IDs/hashes are access-controlled and potentially linkable data.
- Retention durations remain proposals pending privacy/legal approval, not adopted
  defaults or permission to retain data. Proposed ceilings: transient provider
  payloads in memory only; evidence 90 days
  after terminal decision; sealed assets while attached plus at most 30 days after
  retirement, subject to existing deletion duties and approved legal holds. These
  do not extend any existing promise. Erasure/access processing must cover orphan
  bundles, registries/evidence and applicable provider records. No jobs added here.
- Before provider activation, privacy counsel/owner approves purpose, notices and
  consent/other applicable basis, fiduciary/processor roles, DPA/subprocessors,
  cross-border transfers, actual account/endpoint region availability, provider
  retention/abuse monitoring, children/identity-document handling, breach response,
  erasure and retention. Verify applicable DPDP Act/Rules commencement/transitional
  provisions for the release date; this is not a compliance determination.
  Hindi/English notices and accessible grievance handling require product review.

Do not assume zero retention or India residency from API choice. Review exact
endpoint/account controls and image exceptions in [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).
Use the official [MeitY DPDP Rules collection](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?pageTitle=Digit)
including commencement/corrigenda for legal review. Fixtures use synthetic text
and licensed/consented non-sensitive images, never real user records or illegal
image corpora. Legal reporting/retention flows require separate explicit approval.

## 10. Exact future file ownership: Point 2 / Point 3

Only after implementation authorization, both requested worktrees originate from
the SAME approved immutable base including this approved contract. No feature
worktrees are created in this documentation task. Only this specification is
authorized for a dedicated documentation branch, commit and PR targeting main.

| Owner | Exclusive future paths/responsibility |
| --- | --- |
| Point 2 — FairSwap-Backend-OpenAI / feat/moderation-openai-v2 | New `src/lib/moderation/v2/openai.ts`, `evaluate.ts`, `sealer.ts`; new `src/__tests__/moderation-v2-provider.test.ts`, `moderation-v2-evaluator.test.ts`, `moderation-v2-sealer.test.ts`; `src/__tests__/fixtures/moderation-v2/**`. Own provider adapter/local evaluator/sealing interface/recipe and mocked transports; no worker/publication SQL edits. `fraud.ts` / `moderation-v2-fraud.test.ts` remain reserved to Point 2 for a separately authorized future enhancement, not this release. |
| Point 3 — FairSwap-Backend-Approval / feat/moderation-approval-v2 | Sole owner of new `src/lib/moderation/v2/contract.ts`; new `supabase/functions/_shared/listing-moderation-v2-worker.ts`, `supabase/functions/process-listing-moderation-v2/index.ts`, `deno.json`; new `supabase/tests/moderation_v2_*.test.sql`, `src/__tests__/moderation-v2-worker.test.ts`; new forward migrations with CLI-generated names. Own registry, queues, checkpoints, gates, leases/admission, finalizer and namespace-enforcement design; no provider implementation edits. |
| CTO/integration owner only | This contract; `package.json`, `pnpm-lock.yaml`, `vitest.config.*`, `tsconfig.json`, `supabase/config.toml`, CI/workflows, discovery/shared helpers. Serialize reviewed edits; neither stream edits these concurrently. |
| Separately authorized Web/Storage owner | Web upload/processor/delivery/cleanup and privileged Storage enforcement needed for sealed namespace. Neither Point 2 nor Point 3 edits Web. This external dependency blocks activation until approved/verified. |

Point 3 must first deliver a reviewed schema COMMIT containing the exact agreed
shared contract module. Point 2 must not integrate against a working-tree copy,
unreviewed schema or independently reconstructed module. Integration owner supplies
Point 2 that reviewed commit via a controlled cherry-pick; Point 2 consumes
but never edits it. Both worktrees still originate from the same base. No divergent
schema copies. Existing V1 evaluator/worker/test files and historical SQL remain
untouched. Point 3 is the sole migration author; only integration owner changes
dependencies/config/test discovery, after reviewing both branches.

## 11. Acceptance matrix — future requirements, not executed here

| ID / owner | Scenario | Required observation |
| --- | --- | --- |
| C01 / P3 | Unknown version/fields; missing/extra/duplicate checks | No clean/publication; strict rejection |
| C02 / P2+P3 | Image response has text-only category false/zero | not_applicable/null; neither pass nor failure |
| C03 / P2+P3 | Required image category absent; model/support changes | Schema failure; bounded retry/escalation |
| C04 / P2 | Eight images plus two text, out-of-order replies | Exact target/hash attribution; 24 checks (eight text plus 16 per-image instances) |
| C05 / P2 | Orientation/EXIF, corrupt/animated/pixel bomb/oversize | Safe canonical seal or failure, no skipped frames |
| C06 / P2+P3 | Legacy same-key upsert during provider work | Sealed evaluated paths published or superseded; never changed bytes |
| C07 / Storage | Every privileged writer tries sealed overwrite/move/delete | Denied; approved retirement withdraws/invalidate first |
| C08 / P3 | Uploading-row addition, ready transition, delete/cover/order/path change | Complete snapshot mismatch supersedes |
| C09 / P3 | Forged/cross-listing/retired bundle or digest | Registry rejects |
| C10 / P2+P3 | Unicode/null/tied-order TS/SQL preimages | Identical deterministic hashes |
| C11 / P3 | V1/V2 coexist, old worker running | V1 unchanged; V1 cannot claim/finalize V2 |
| C12 / P3 | Gate absent/off/shadow; disabled during evaluation | No V2 publication/fallback or V1 setting changes |
| C13 / P3 | Crash/lease loss/lock delay beyond expiry | No stale commit; slots recovered; bounded abandonment |
| C14 / P2+P3 | 429/Retry-After/5xx/timeout/schema/401 | Exact retry policy/circuit breaker; never seller-invalid |
| C15 / P3 | Lost finalization response/duplicate/conflicting replay | One transition/audit/notification or conflict |
| C16 / P3 | Concurrent Admin/seller action | Valid single winner; existing PT409/AAL2 preserved |
| C17 / P3 | Account/policy/category changes; experimental publication blocked | No bypass or category launch |
| C18 / P3 | anon/authenticated/forged secret/Vault outage | Denied before claim; no grant/secret leaks |
| C19 / P2 | Hindi/Hinglish scam/benign/obfuscated gap fixtures | Characterize current misses; no new mandatory fraud rule or claim of reliable detection; V1 expectations unchanged |
| C20 / P2+privacy | Payload/error/EXIF traps; erasure | No sensitive logs; deletion/retention coverage |
| C21 / Integration | Existing seller RPCs/media HTTP/staff contracts across clients | Existing consumer suites pass under authorized scope |
| C22 / P2+P3 | Synthetic feasibility at provisional two attempts/ten inputs each | Measure safe runtime limits; provisional maximum four global calls, no waiting preclaims; freeze reviewed values before activation |
| C23 / P3 | SQL failure mid attachment/publication/evidence | Complete rollback, no partial visibility |
| C24 / Integration | Environment-specific forward plan and V1 regression | No raw 58-file push or Test-only promotion |
| C25 / P3 | Invalid title/description before any ready/sealed media | Strict input_validation result without snapshot; DB-verifiable errors; no provider or publication |
| C26 / P2+P3 | Smuggle snapshot/checks into early phase or omit sealed snapshot from evaluation | Strict union rejects cross-phase payloads; early phase cannot report clean/review success |
| C27 / Integration | Image processor placement / native dependency feasibility | No Sharp-in-Edge assumption; separately approved safe processor and enforceable immutable bundle boundary before publication activation |

Mocked unit/provider tests block real network, use explicit Node discovery and no
automatic env loading. DB/full-stack tests require separately authorized disposable
environments. Live provider calibration needs separate approved fixtures/credentials.
No schema/mocked test proves hosted acceptance or release readiness.

## 12. CTO decisions and blocking prerequisites

1. Sealed bundles are the approved target. Prove enforceable namespace/retirement
   protection AND safe image-processing placement before publication activation.
   Sharp in Edge is not assumed; no Web changes are authorized.
2. Initial model omni-moderation-2024-09-26 and the 13-text/six-image support matrix
   are approved. Keep the three FairSwap rules unchanged; future India scam rules
   need separate scope/policy, not a current implementation dependency.
3. Establish invocation/lease/concurrency/timeout feasibility with synthetic mocked
   workloads, then approve measured limits; DB leases/bounded retries/fail-closed
   behavior remain mandatory regardless of the selected numbers.
4. Privacy/transfer/account controls and proposed retention durations await legal/
   privacy approval. No real user data, live requests or provider credentials now.
5. Before implementation, approve the common base and obtain Point 3's reviewed
   schema commit for Point 2. This documentation PR is not implementation/release
   authorization. Current Test/Production V1 settings remain untouched; ownership
   and exact hosted forward plans remain independent release gates.

## 13. Documentation verification boundary

Only this document is added in a separate worktree at the pinned Backend base.
No application code, test, migration or configuration is changed. Source inspected
at pinned refs; no hosted Supabase state queried. Original checkout's four existing
document modifications are preserved. Design-schema checks are not
application/database/provider/consumer acceptance. Stop for CTO review.

Final revision validation: extracted the TypeScript fence to an OS-temporary file
and checked it with existing pinned TypeScript/Zod dependencies (strict, noEmit):
PASS. Executed 38 synthetic schema cases: 38/38 PASS. They cover one/eight images
(10/24 checks), removed fraud IDs/reasons, exact modality coverage, strict early
invalid-input envelopes without snapshots, cross-phase smuggling, incomplete
outcomes, missing/duplicate checks, hashes, versions, flags and retries.
Characterized all ten documented synthetic gap fixtures using the unchanged pure
three-rule checker: ten no_review_flags outcomes, including the five risky examples.
These observed misses remain explicit coverage gaps; no production expectations
were altered. Fetch/socket access was blocked; zero network attempts. The initial
fixture-table parser counted its Markdown separator; fixing only the temporary
validation harness produced the final results above.

Validation command: `node "$env:TEMP/fairswap-v2-contract-validation.cjs"` from
the documentation worktree. The temporary harness extracts the schema, invokes
TypeScript strict/noEmit and evaluates the in-memory synthetic cases/fixtures;
neither it nor the extracted temporary schema is a repository change. No package
installation, application suite, SQL, provider credential or provider call was
involved. Markdown whitespace/fences passed. Original four modified files'
SHA-256 values matched preflight (4/4); original HEAD/branch/index unchanged.

Git operations: read-only status/rev-parse/diff and pinned source inspection;
`git fetch --no-tags --no-write-fetch-head origin main` acquired missing objects
and updated the cached origin/main ref, without changing local main or working
files. The first managed worktree attempt failed with invalid reference before
that fetch; the subsequent detached worktree succeeded at the exact verified SHA.
Under the final explicit CTO instruction, only this document is staged/committed
on `codex/docs-moderation-v2-contract` and submitted as a PR targeting main. No
automatic merge or implementation branch/worktree is authorized by that action.
