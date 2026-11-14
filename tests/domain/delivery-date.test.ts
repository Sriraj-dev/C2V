import { describe, it, expect } from 'vitest';
import {
  nextDeliveryDate,
  weekdayName,
  formatDeliveryDate,
  addDays,
  frequencyStepDays,
} from '../../src/domain/delivery-date.js';

describe('nextDeliveryDate', () => {
  // 2026-11-12 is a Thursday in IST
  it('returns the next Wednesday from a Thursday', () => {
    expect(nextDeliveryDate(new Date('2026-11-12T06:00:00Z'), 3)).toBe('2026-11-18');
  });
  it('ordering on the delivery weekday goes to next week', () => {
    expect(nextDeliveryDate(new Date('2026-11-18T06:00:00Z'), 3)).toBe('2026-11-25');
  });
  it('uses IST, not UTC, for the weekday', () => {
    // 2026-11-17T20:00Z is Wed 01:30 IST, still Wednesday in IST
    expect(nextDeliveryDate(new Date('2026-11-17T20:00:00Z'), 3)).toBe('2026-11-25');
  });
  it('switches day exactly at IST midnight', () => {
    // Tue 23:59 IST → delivery is tomorrow (Wed)
    expect(nextDeliveryDate(new Date('2026-11-17T18:29:00Z'), 3)).toBe('2026-11-18');
    // Wed 00:00 IST → it is already Wednesday → next week
    expect(nextDeliveryDate(new Date('2026-11-17T18:30:00Z'), 3)).toBe('2026-11-25');
  });
  it('rolls over month and year', () => {
    // Thu 31 Dec 2026 IST → next Wed is 6 Jan 2027
    expect(nextDeliveryDate(new Date('2026-12-31T06:00:00Z'), 3)).toBe('2027-01-06');
  });
  it('rejects a weekday outside 0-6 or non-integer', () => {
    const now = new Date('2026-11-12T06:00:00Z');
    expect(() => nextDeliveryDate(now, 7)).toThrow();
    expect(() => nextDeliveryDate(now, -1)).toThrow();
    expect(() => nextDeliveryDate(now, 2.5)).toThrow();
    expect(() => nextDeliveryDate(now, NaN)).toThrow();
  });
});

describe('formatDeliveryDate', () => {
  it('formats an ISO date as weekday, day, month', () => {
    expect(formatDeliveryDate('2026-11-18')).toBe('Wed, 18 Nov');
  });
});

describe('addDays', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-11-18', 28)).toBe('2026-12-16');
  });
  it('rolls over the year', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('handles leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
  it('handles negative offsets', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('frequencyStepDays', () => {
  it('maps frequencies to day steps', () => {
    expect(frequencyStepDays('weekly')).toBe(7);
    expect(frequencyStepDays('biweekly')).toBe(14);
    expect(frequencyStepDays('monthly')).toBe(28);
  });
});

describe('weekdayName', () => {
  it('names weekdays and falls back', () => {
    expect(weekdayName(0)).toBe('Sunday');
    expect(weekdayName(3)).toBe('Wednesday');
    expect(weekdayName(9)).toBe('day');
  });
});
