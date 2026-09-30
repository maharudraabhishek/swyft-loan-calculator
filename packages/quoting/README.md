# Quoting (`@swyft/quoting`)

Sits between a lender's settings and the finance engine. It takes a **fee signature** (a lender product: fees, commission model, timing, caps) and the **broker's choices** (amount, term, rates, balloon, which fees to finance) and builds the input for the engine. The desktop preview and the API's recalculation both use it, so they always get the same numbers.

## What it does

- **Fees:** decides which fees are financed and which are paid at settlement (per-quote overrides of the lender defaults); applies dynamic lender fees (Autopay and Metro raise their fee with the broker's origination fee, up to a cap) and the origination cap.
- **Lender rules:** commission caps, the required contract rate for overs lenders, and dates for daily-interest lenders. A broken rule becomes a `QuoteCompositionError` naming the field, so the app can show the message next to the right input.
- **Target commission:** `solveTargetCommission` reverse-calculates the contract rate (overs) or commission % (other models) that earns a target dollar amount.
- **Transport and storage:** maps API/IPC DTOs to domain objects, formats results for storage and display (money to the cent), dates monthly schedules, and serialises the immutable quote snapshot.

## Files

| File                   | Contents                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `fee-signature.ts`     | Domain types: `FeeSignature`, `QuoteRequest`, `QuoteCompositionError`                     |
| `compose.ts`           | `composeQuote`, `calculateFromSignature`, fee resolution, signature consistency checks    |
| `target-commission.ts` | Target commission solver                                                                  |
| `transport.ts`         | DTO mapping, result summary, dated schedules                                              |
| `snapshot.ts`          | JSON snapshot of inputs, results and signatures (decimals kept as full-precision strings) |

`pnpm --filter @swyft/quoting test` runs its tests.
