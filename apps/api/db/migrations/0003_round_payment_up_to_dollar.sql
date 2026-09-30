-- Whole-dollar repayments (brief, "Rounding Rules": some lenders round the payment up to
-- a whole dollar). A lender product with this set charges its cent payment rounded up to
-- the next dollar; the finance engine reduces the final instalment so the loan closes
-- exactly. No built-in lender uses it, so every existing row keeps the default (false);
-- brokers can switch it on for their own fee signatures.
--
-- Additive only: the column has a default, so existing inserts (which do not name it)
-- keep working. Table-level grants and row-level security already cover new columns.

ALTER TABLE app.fee_signatures
  ADD COLUMN round_payment_up_to_dollar boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.fee_signatures.round_payment_up_to_dollar IS
  'Lender rounds the repayment up to the next whole dollar; the final instalment is reduced.';
