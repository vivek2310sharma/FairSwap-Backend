import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ratingScore} from '../../src/lib/ratings/score.ts';
import {submitReviewSchema,tradeEventSchema,ratingSummarySchema} from '../../src/lib/ratings/contract.ts';
test('all 64 face combinations and required score examples',()=>{
 for(let a=1;a<=4;a++)for(let b=1;b<=4;b++)for(let c=1;c<=4;c++)assert.equal(ratingScore(a,b,c),Math.round((((a+b+c)/3-1)/3*10)*10)/10);
 assert.equal(ratingScore(1,1,1),0);assert.equal(ratingScore(3,3,4),7.8);assert.equal(ratingScore(4,4,4),10);
 for(const x of [null,NaN,Infinity,0,5,1.1,'4'])assert.throws(()=>ratingScore(x,4,4),RangeError);
});
test('review input boundary normalizes Unicode, counts codepoints, rejects unsafe content and duplicate tags',()=>{
 const base={trade_id:'00000000-0000-4000-8000-000000000001',communication:4,payment_item:4,meetup:4};
 assert.equal(submitReviewSchema.parse({...base,body:'e\u0301'}).body,'é');
 assert(submitReviewSchema.safeParse({...base,body:'😀'.repeat(500)}).success);
 for(const body of ['😀'.repeat(501),'<script>','\u0085','\u202e','\n'])assert(!submitReviewSchema.safeParse({...base,body}).success);
 assert(!submitReviewSchema.safeParse({...base,tags:['polite','polite']}).success);
 assert(!submitReviewSchema.safeParse({...base,communication:2.5}).success);
 assert(!submitReviewSchema.safeParse({...base,recipient_id:base.trade_id}).success);
});
test('system events require fixed typed shape without user content or URL',()=>{
 const event={id:'00000000-0000-4000-8000-000000000001',trade_id:'00000000-0000-4000-8000-000000000002',created_at:'2026-10-26T00:00:00Z',kind:'confirmed'};
 assert(tradeEventSchema.safeParse(event).success);
 assert(!tradeEventSchema.safeParse({...event,content:'Official payment link'}).success);
 assert(!tradeEventSchema.safeParse({...event,kind:'system_trade'}).success);
});
test('zero is a valid rated score; null is a distinct unrated state',()=>{
 const s={user_id:'00000000-0000-4000-8000-000000000001',published_review_count:3,counted_review_count:3,completed_trades:3,score:0,communication_average:1,payment_item_average:1,meetup_average:1,display_state:'rated'};
 assert(ratingSummarySchema.safeParse(s).success);
 assert(ratingSummarySchema.safeParse({...s,score:null,display_state:'no_rating_yet'}).success);
});
