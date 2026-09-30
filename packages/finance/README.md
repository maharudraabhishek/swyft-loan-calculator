# Finance engine (`@swyft/finance`)

Pure TypeScript loan calculations, with no I/O and no framework. Given validated inputs it returns the repayment, commission, amounts financed, comparison or customer rate, total hiring and a full amortisation schedule. The desktop preview and the API both call it, so a preview and a saved quote are calculated by the same code.

## Precision

All arithmetic uses a package-owned Decimal.js clone (40 significant digits, round half-up). Values arrive and leave as `Money`, `AnnualRate` (0.085 = 8.5% p.a.) and `Fraction` (0.04 = 4%) objects, never as floats. Only the final payment, commission and totals are rounded to the cent.

## Commission models

`calculateQuote(input)` picks the model from `input.model`:

| `model`       | Brief name                                                    | How the broker is paid                                                                          | Interest runs on                                  |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `capitalised` | Capitalised brokerage (Traditional, Westpac, Metro, Firstmac) | Commission = % of NAF, added to the loan                                                        | NAF + commission, at the base rate                |
| `branded`     | Commission overs (Branded)                                    | MAX(base commission, 75% × hiring difference × 1.10) from the contract rate above the base rate | NAF, at the contract rate                         |
| `pepper`      | Loaded commission (Pepper)                                    | Commission = % of NAF; a loading of it is added to the loan                                     | NAF + loading × commission, at the financier rate |
| `autopay`     | Daily interest with rate adjustment (Autopay/MoneyMe)         | Commission added to the principal; contract rate = base + commission% × 0.4                     | Balance × rate/365 × actual days                  |

Fee signatures (in the API and database) name these models `capitalised`, `overs`, `loaded` and `daily_interest`; `@swyft/quoting` maps them to the engine.

Payment timing (`advance` or `arrears`) is a separate setting: advance = arrears payment ÷ (1 + i). `paymentRounding: 'dollar-up'` supports lenders that round the payment up to a whole dollar (the final instalment is then reduced).

## Files

| File                                         | Contents                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `quote.ts`                                   | `calculateQuote`: the four models                                                             |
| `math.ts`                                    | Level payment formula (with balloon and timing) and the rate solver used for comparison rates |
| `daily.ts`, `dates.ts`                       | Daily-interest payment solver; payment dates with weekend and NSW public-holiday moves        |
| `amortization.ts`, `schedule.ts`             | Period-by-period amortisation and `generateSchedule`                                          |
| `value-objects.ts`, `types.ts`, `decimal.ts` | Money/rate types, inputs and results, the Decimal policy                                      |

## Tests

`pnpm --filter @swyft/finance test` runs:

- **The brief's formulas and worked example**, line by line (`brief-math-spec.test.ts`).
- **SPG's four HTML calculators**, run unmodified over an input grid (`spg-calculators-grid.test.ts`).
- **The official `test-cases.json`** (`upstream-fixtures.test.ts`). 5 of its 8 cases fail (10 of 49 expected values) because those values contradict SPG's own calculators and schedules. `fixture-disputes.test.ts` proves each one; the main README explains them under Known limitations.
- **The lender CSV schedules, whole-dollar rounding, dates and domain rules.**
