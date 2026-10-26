import { z } from 'zod';

export const reviewFacesSchema = z.object({
  communication: z.number().int().min(1).max(4),
  payment_item: z.number().int().min(1).max(4),
  meetup: z.number().int().min(1).max(4),
}).strict();
const textSchema = z.string().transform((s) => s.normalize('NFC').replace(/^ +| +$/g, ''))
  .refine((s) => Array.from(s).length <= 500 && !/[\u0000-\u001f\u007f-\u009f<>\u202a-\u202e\u2066-\u2069\ufeff]/u.test(s), 'RATINGS_INVALID_TEXT');
export const submitReviewSchema = reviewFacesSchema.extend({
  trade_id: z.string().uuid(), body: textSchema.nullable().default(null),
  tags: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(5).default([])
    .refine((tags) => new Set(tags).size === tags.length, 'RATINGS_INVALID_TAGS'),
}).strict();
export const tradeStateSchema = z.enum(['pending_selection', 'pending_buyer', 'confirmed', 'disputed', 'unattributed', 'expired_unconfirmed']);
export const tradeEventSchema = z.object({
  id: z.string().uuid(), trade_id: z.string().uuid(), created_at: z.string().datetime({ offset: true }),
  kind: z.enum(['buyer_selected', 'pending_buyer', 'confirmed', 'rated_buyer', 'rated_seller', 'disputed', 'expired']),
}).strict();
export const cursorSchema = z.object({ before_at: z.string().datetime({ offset: true }), before_id: z.string().uuid() }).strict();
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item).max(20), has_more: z.boolean(), next_cursor: cursorSchema.nullable() }).strict();
}
export const ratingSummarySchema = z.object({
  user_id: z.string().uuid(), published_review_count: z.number().int().nonnegative(),
  counted_review_count: z.number().int().nonnegative(), completed_trades: z.number().int().nonnegative(),
  score: z.number().min(0).max(10).nullable(), communication_average: z.number().min(1).max(4).nullable(),
  payment_item_average: z.number().min(1).max(4).nullable(), meetup_average: z.number().min(1).max(4).nullable(),
  display_state: z.enum(['rated', 'no_rating_yet']),
}).strict();
export type RatingSummary = z.infer<typeof ratingSummarySchema>;
export type SubmitReview = z.infer<typeof submitReviewSchema>;
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
export const reviewSchema = reviewFacesSchema.extend({
  id: uuid, author_id: uuid.nullable(), recipient_id: uuid.nullable(), reviewer_role: z.enum(['buyer', 'seller']),
  score: z.number().min(0).max(10), body: z.string().nullable(), tags: z.array(z.string()).max(5),
  submitted_at: timestamp, published_at: timestamp.nullable(),
  reply: z.object({ body: z.string(), created_at: timestamp }).strict().nullable(),
}).strict();
export const pendingActionSchema = z.object({
  id: uuid, listing_id: uuid.nullable(), sold_at: timestamp, deadline: timestamp, state: tradeStateSchema,
  action: z.enum(['select_buyer', 'confirm_and_rate', 'rate']),
}).strict();
export const buyerCandidateSchema = z.object({ id: uuid, buyer_id: uuid, display_name: z.string(), created_at: timestamp }).strict();
export const tradeSchema = z.object({
  id: uuid, listing_id: uuid.nullable(), conversation_id: uuid.nullable(), state: tradeStateSchema, deadline: timestamp,
  buyer_confirmed: z.boolean(), can_dispute: z.boolean(), my_review_id: uuid.nullable(),
  my_rating_status: z.enum(['submitted', 'not_rated', 'pending']),
}).strict();
export const sellRequestSchema = z.discriminatedUnion('choice', [
  z.object({ listing_id: uuid, choice: z.literal('select'), conversation_id: uuid }).strict(),
  z.object({ listing_id: uuid, choice: z.literal('pending'), conversation_id: z.null().default(null) }).strict(),
  z.object({ listing_id: uuid, choice: z.literal('none'), conversation_id: z.null().default(null) }).strict(),
]);
export const sellResultSchema = z.object({ trade_id: uuid, state: tradeStateSchema, deadline: timestamp }).strict();
export const buyerActionRequestSchema = z.object({ trade_id: uuid, action: z.enum(['confirm', 'dispute']) }).strict();
export const buyerActionResultSchema = z.object({ trade_id: uuid, state: z.enum(['confirmed', 'disputed']) }).strict();
