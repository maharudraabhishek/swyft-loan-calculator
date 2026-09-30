// Finance gate for CI. Runs the finance test suite and passes only when the result is
// exactly the documented state: every test passes except the five disputed official
// cases in tests/fixtures/upstream/test-cases.json, and each of those differs on exactly
// the values explained in README.md (Known limitations). Any other failure fails the gate,
// and so does a disputed value that changes or starts to match (then update the README
// and the list below together).
//
// Usage: node scripts/check-finance.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const officialSuite = 'tests/upstream-fixtures.test.ts';

// Case id → the differences the official test reports. Rates are compared to 4 decimals.
const documented = {
  'westpac-basic': [
    'monthly_payment: expected 656.19, got 646.10',
    'comparison_rate: expected 0.0923, got 0.1025',
    'total_interest: expected 7656.6, got 7051.27',
  ],
  'westpac-with-balloon': [
    'monthly_payment: expected 844.22, got 914.16',
    'comparison_rate: expected 0.0878, got 0.0963',
  ],
  'pepper-origination-financed': [
    'amount_financed: expected 35845.85, got 35846.08',
  ],
  'pepper-all-fees-financed': [
    'amount_financed: expected 36352.85, got 36362.53',
    'monthly_payment: expected 805.73, got 805.95',
  ],
  'autopay-daily-interest': [
    'first_payment_interest: expected 147.01, got 147.11',
    'second_payment_interest: expected 495.29, got 639.16',
  ],
};

/**
 * Reads the differences of each failed official case from the default reporter's text
 * (the JSON report has each test's status but not the assertion diff). A failed case
 * prints a "FAIL  tests/upstream-fixtures.test.ts > ... > <case id>" header, followed by
 * diff lines such as `+   "monthly_payment: expected 656.19, got 646.10 (tol 0.01)",`.
 */
function officialDifferences(output) {
  const byCase = new Map();
  let current;
  for (const line of output.split(/\r?\n/)) {
    const header = /FAIL\s+(\S+) > .+ > ([\w-]+)\s*$/.exec(line);
    if (header) {
      current = header[1].endsWith(officialSuite) ? header[2] : undefined;
      if (current) byCase.set(current, []);
      continue;
    }
    const diff = /^\+\s+"([a-z_]+): expected ([^,]+), got (\S+) \(tol/.exec(
      line,
    );
    if (current && diff) {
      const [, field, expected, got] = diff;
      const actual = field.includes('rate') ? Number(got).toFixed(4) : got;
      byCase.get(current).push(`${field}: expected ${expected}, got ${actual}`);
    }
  }
  return byCase;
}

const financeRoot = fileURLToPath(
  new URL('../packages/finance/', import.meta.url),
);
const vitest = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
);
const outputDir = mkdtempSync(join(tmpdir(), 'swyft-finance-'));
const report = join(outputDir, 'report.json');

try {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const run = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
    ],
    { cwd: financeRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);

  const results = JSON.parse(readFileSync(report, 'utf8'));
  const reported = officialDifferences(`${run.stdout}\n${run.stderr}`);
  const problems = [];
  const seen = new Set();
  for (const file of results.testResults) {
    const official = file.name.replaceAll('\\', '/').endsWith(officialSuite);
    for (const test of file.assertionResults) {
      const known = official ? documented[test.title] : undefined;
      if (known) {
        seen.add(test.title);
        const actual = [...(reported.get(test.title) ?? [])].sort();
        const expected = [...known].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          problems.push(
            `${test.title}: documented differences changed\n    expected: ${expected.join(' | ')}\n    actual:   ${actual.join(' | ') || '(none: the case passes or its output was not recognised)'}`,
          );
      } else if (test.status !== 'passed') {
        problems.push(`${test.fullName}: ${test.status}`);
      }
    }
  }
  for (const id of Object.keys(documented))
    if (!seen.has(id))
      problems.push(`${id}: official case not found in ${officialSuite}`);
  if (results.numTotalTests === 0) problems.push('no finance tests ran');

  if (problems.length > 0) {
    console.error(`\nFinance gate: FAIL\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nFinance gate: PASS (${results.numPassedTests} tests passed; the ${seen.size} disputed official cases differ exactly as documented in README.md)`,
    );
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
