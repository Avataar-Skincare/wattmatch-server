import { describe, it, expect } from 'vitest';
import { seedBodySchema, MAX_WINDOW_SECONDS, MAX_AUTO_EXTENSIONS_CAP } from './auctionAdmin.js';
import { MAX_BID_AMOUNT } from '../services/auctionEngine.js';

// This schema replaced a hand-written if-chain that, in practice, had real gaps only found by
// manual review (missing per-participant validation, missing upper bounds) — these tests exist so
// that class of gap can't silently return: every constraint the schema is supposed to enforce gets
// a test that would fail if that constraint were ever accidentally loosened or removed.
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test auction',
    openingBid: 6.5,
    windowSeconds: 300,
    maxAutoExtensions: 5,
    useLandedRate: true,
    equityValue: 1000000,
    totalUnitsPerYear: 500000,
    participants: [{ organizationName: 'Gen A', alias: 'GEN-A' }],
    ...overrides,
  };
}

describe('seedBodySchema', () => {
  it('accepts a well-formed body', () => {
    const result = seedBodySchema.safeParse(validBody());
    expect(result.success).toBe(true);
  });

  it('accepts an optional buyer', () => {
    const result = seedBodySchema.safeParse(validBody({ buyer: { organizationName: 'Buyer Co', alias: 'BUYER' } }));
    expect(result.success).toBe(true);
  });

  it('applies default windowSeconds and maxAutoExtensions when omitted', () => {
    const { windowSeconds, maxAutoExtensions, ...rest } = validBody();
    const result = seedBodySchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windowSeconds).toBe(480);
      expect(result.data.maxAutoExtensions).toBe(8);
    }
  });

  it('rejects a missing title', () => {
    const { title, ...rest } = validBody();
    expect(seedBodySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty-string title', () => {
    expect(seedBodySchema.safeParse(validBody({ title: '' })).success).toBe(false);
  });

  it('rejects a zero or negative openingBid', () => {
    expect(seedBodySchema.safeParse(validBody({ openingBid: 0 })).success).toBe(false);
    expect(seedBodySchema.safeParse(validBody({ openingBid: -5 })).success).toBe(false);
  });

  it('rejects an openingBid above MAX_BID_AMOUNT', () => {
    expect(seedBodySchema.safeParse(validBody({ openingBid: MAX_BID_AMOUNT + 1 })).success).toBe(false);
  });

  it('accepts an openingBid exactly at MAX_BID_AMOUNT', () => {
    expect(seedBodySchema.safeParse(validBody({ openingBid: MAX_BID_AMOUNT })).success).toBe(true);
  });

  it('rejects windowSeconds above MAX_WINDOW_SECONDS', () => {
    expect(seedBodySchema.safeParse(validBody({ windowSeconds: MAX_WINDOW_SECONDS + 1 })).success).toBe(false);
  });

  it('rejects maxAutoExtensions above MAX_AUTO_EXTENSIONS_CAP', () => {
    expect(seedBodySchema.safeParse(validBody({ maxAutoExtensions: MAX_AUTO_EXTENSIONS_CAP + 1 })).success).toBe(false);
  });

  it('accepts maxAutoExtensions of exactly 0 (non-negative, not "must be positive")', () => {
    expect(seedBodySchema.safeParse(validBody({ maxAutoExtensions: 0 })).success).toBe(true);
  });

  it('accepts useLandedRate: false with equityValue/totalUnitsPerYear omitted', () => {
    const { equityValue, totalUnitsPerYear, ...rest } = validBody({ useLandedRate: false });
    expect(seedBodySchema.safeParse(rest).success).toBe(true);
  });

  it('rejects useLandedRate: true with equityValue/totalUnitsPerYear omitted', () => {
    const { equityValue, totalUnitsPerYear, ...rest } = validBody();
    expect(seedBodySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty participants array', () => {
    expect(seedBodySchema.safeParse(validBody({ participants: [] })).success).toBe(false);
  });

  it('rejects a participant with an empty organizationName', () => {
    expect(
      seedBodySchema.safeParse(validBody({ participants: [{ organizationName: '', alias: 'GEN-A' }] })).success
    ).toBe(false);
  });

  it('rejects a participant with an empty alias', () => {
    expect(
      seedBodySchema.safeParse(validBody({ participants: [{ organizationName: 'Gen A', alias: '' }] })).success
    ).toBe(false);
  });

  it('rejects a participant missing alias entirely', () => {
    expect(seedBodySchema.safeParse(validBody({ participants: [{ organizationName: 'Gen A' }] })).success).toBe(false);
  });

  it('rejects duplicate aliases between two participants', () => {
    const result = seedBodySchema.safeParse(
      validBody({
        participants: [
          { organizationName: 'Gen A', alias: 'SAME' },
          { organizationName: 'Gen B', alias: 'SAME' },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a buyer alias colliding with a generator alias', () => {
    const result = seedBodySchema.safeParse(
      validBody({
        participants: [{ organizationName: 'Gen A', alias: 'SAME' }],
        buyer: { organizationName: 'Buyer Co', alias: 'SAME' },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a buyer with an empty organizationName', () => {
    const result = seedBodySchema.safeParse(validBody({ buyer: { organizationName: '', alias: 'BUYER' } }));
    expect(result.success).toBe(false);
  });

  it('reports multiple distinct problems at once, not just the first', () => {
    const result = seedBodySchema.safeParse(
      validBody({
        openingBid: MAX_BID_AMOUNT + 1,
        participants: [
          { organizationName: 'Gen A', alias: 'SAME' },
          { organizationName: 'Gen B', alias: 'SAME' },
        ],
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
