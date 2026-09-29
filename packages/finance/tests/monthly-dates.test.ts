import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { monthlyDueDate } from '../src/index.js';

const upstream = new URL('../../../tests/fixtures/upstream/', import.meta.url);

/** `13/01/2025` → `2025-01-13` */
const toIso = (dmy: string) => {
  const [day, month, year] = dmy.split('/');
  return `${year}-${month}-${day}`;
};

describe('monthly schedule dates', () => {
  it.each([
    ['pepper/test-case-1-w-e.csv'],
    ['pepper/test-case-2-h-y-c-pty-ltd.csv'],
    ['pepper/test-case-3-g-i-i-pty-ltd.csv'],
  ])('reproduces every payment date of %s (advance)', (file) => {
    const csv = readFileSync(new URL(file, upstream), 'utf8');
    const start = /# Start Date: (\d{2}\/\d{2}\/\d{4})/.exec(csv)?.[1];
    const dates = csv
      .split(/\r?\n/)
      .filter((line) => /^\d+,/.test(line))
      .map((line) => toIso(line.split(',')[1] ?? ''));
    expect(dates).toHaveLength(60);
    expect(start).toBeDefined();
    dates.forEach((date, index) =>
      expect(monthlyDueDate(toIso(start ?? ''), index + 1, 'advance')).toBe(
        date,
      ),
    );
  });

  it('starts arrears schedules one month after settlement', () => {
    expect(monthlyDueDate('2025-01-15', 1, 'arrears')).toBe('2025-02-15');
    expect(monthlyDueDate('2025-01-15', 12, 'arrears')).toBe('2026-01-15');
  });

  it('keeps a month-end settlement day, clamped in shorter months', () => {
    expect(monthlyDueDate('2025-01-31', 1, 'arrears')).toBe('2025-02-28');
    expect(monthlyDueDate('2025-01-31', 2, 'arrears')).toBe('2025-03-31');
    expect(monthlyDueDate('2024-01-31', 1, 'arrears')).toBe('2024-02-29');
  });

  it('rejects invalid periods and dates', () => {
    expect(() => monthlyDueDate('2025-01-15', 0, 'advance')).toThrow(
      RangeError,
    );
    expect(() => monthlyDueDate('2025-02-30', 1, 'advance')).toThrow(
      RangeError,
    );
  });
});
