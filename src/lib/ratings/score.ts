/** Reference only. PostgreSQL owns persisted scores; raw faces are integers 1..4. */
export function ratingScore(communication: number, paymentItem: number, meetup: number): number {
  const faces = [communication, paymentItem, meetup];
  if (faces.some((value) => !Number.isInteger(value) || value < 1 || value > 4)) {
    throw new RangeError('RATINGS_INVALID_FACES');
  }
  return Math.round(((communication + paymentItem + meetup) - 3) / 9 * 100) / 10;
}
