import test from 'node:test';
import assert from 'node:assert/strict';
import {findIndiaFraudSignals} from '../../src/lib/moderation/v2/india-fraud.ts';

const cases = [
  ['देखने से पहले ₹500 टोकन UPI से भेजें', ['ADVANCE_VIEWING']],
  ['Pehle 500 token UPI karo, phir bike dekh lena', ['ADVANCE_VIEWING']],
  ['Paise receive karne ke liye QR scan karke UPI PIN dalo', ['OTP_PIN','QR_RECEIVE']],
  ['अपना OTP और UPI PIN मुझे भेजें', ['OTP_PIN']],
  ['Main army officer hoon, delivery se pehle refundable courier fee bhejo', ['IMPERSONATION_FEE']],
  ['OTP ya UPI PIN kabhi share mat karo', []],
  ['Dekhne se pehle koi advance mat bhejna', []],
  ['UPI accepted after inspection; cash bhi chalega', []],
  ['Army-green bicycle, local pickup', []],
  ['Heroine-themed poster and glue gun for sale', []],
  ['Send O\u200bTP now', ['OTP_PIN']],
  ['Never share your UPI PIN with anyone', []],
  ['Bring cash after inspection for the scooter', []],
  ['I am a soldier selling this old book', []],
];
for (const [input, expected] of cases) {
  test(input, () => {
    const actual = [...new Set(findIndiaFraudSignals(input).map(x => x.id))].sort();
    assert.deepEqual(actual, expected.slice().sort());
  });
}
