-- Built-in lenders and fee signatures from the quoting-tool brief ("Fee Signatures").
-- Fixed IDs keep presets stable across environments. owner_user_id NULL = preset.
-- Where the brief's preset table and lender-configs.json differ, the preset table wins
-- (e.g. Branded timing is Advance). Autopay is daily interest, which the engine accrues
-- in arrears (see docs/FINANCE_SPEC.md). Pepper lender fees default to upfront as in
-- lender-configs.json; a quote may choose to finance them.

INSERT INTO app.lenders (id, name, website_url) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Pepper', 'https://www.peppermoney.com.au/'),
  ('00000000-0000-4000-8000-000000000002', 'Firstmac', 'https://www.firstmac.com.au/'),
  ('00000000-0000-4000-8000-000000000003', 'Westpac', 'https://www.westpac.com.au/'),
  ('00000000-0000-4000-8000-000000000004', 'Branded', 'https://www.brandedfinancial.com.au/'),
  ('00000000-0000-4000-8000-000000000005', 'Autopay', 'https://www.autopay.com.au/'),
  ('00000000-0000-4000-8000-000000000006', 'Metro', 'https://metrofin.com.au/');

INSERT INTO app.fee_signatures (
  id, lender_id, name, commission_model, interest_method, payment_timing,
  default_commission_rate, max_commission_rate, base_commission, overs_share, gst_rate,
  loading_factor, rate_markup_factor, monthly_fee, sliding_fee, max_broker_origination,
  establishment_fee, establishment_financed, establishment_fee_max,
  ppsr_registration_fee, ppsr_registration_financed, ppsr_search_fee, ppsr_search_financed,
  private_sale_fee, private_sale_financed
) VALUES
  -- Pepper Commercial Dealer: $499 lender fee + $6 PPSR, loaded commission, advance.
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
   'Commercial Dealer', 'loaded', 'monthly', 'advance', 0.02, 0.04, NULL, NULL, NULL, 0.4, NULL, 0, 0, NULL,
   499, false, NULL, 6, false, NULL, NULL, NULL, NULL),
  -- Pepper Commercial Private: $600 lender + $6 PPSR + $2 PPSR search.
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001',
   'Commercial Private', 'loaded', 'monthly', 'advance', 0.02, 0.04, NULL, NULL, NULL, 0.4, NULL, 0, 0, NULL,
   600, false, NULL, 6, false, 2, false, NULL, NULL),
  -- Firstmac: $499 / $599 application fee, $8 monthly fee, capitalised, arrears.
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000002',
   'Dealer', 'capitalised', 'monthly', 'arrears', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 8, 0, NULL,
   499, true, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000002',
   'Private', 'capitalised', 'monthly', 'arrears', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 8, 0, NULL,
   599, true, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Westpac: $500 lender fee (+ $250 private sale fee), capitalised, advance; 4% standard, 6% max.
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000003',
   'Dealer', 'capitalised', 'monthly', 'advance', 0.04, 0.06, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL,
   500, true, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000003',
   'Private', 'capitalised', 'monthly', 'advance', 0.04, 0.06, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL,
   500, true, NULL, NULL, NULL, NULL, NULL, 250, true),
  -- Branded: $550 / $650 + $6 PPSR, $8 monthly account fee, commission overs.
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000004',
   'Dealer', 'overs', 'monthly', 'advance', NULL, NULL, 110, 0.75, 0.10, NULL, NULL, 8, 0, NULL,
   550, true, NULL, 6, true, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000004',
   'Private', 'overs', 'monthly', 'advance', NULL, NULL, 110, 0.75, 0.10, NULL, NULL, 8, 0, NULL,
   650, true, NULL, 6, true, NULL, NULL, NULL, NULL),
  -- Autopay: lender fee $350 + origination up to $550; $12.50 monthly and first-payment sliding fee.
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000005',
   'Standard', 'daily_interest', 'daily', 'arrears', NULL, NULL, NULL, NULL, NULL, NULL, 0.4, 12.50, 12.50, NULL,
   350, true, 550, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Metro: lender fee $275 + origination up to $450, broker origination capped at $450, $8.25 PPSR.
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000006',
   'Standard', 'capitalised', 'monthly', 'advance', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 450,
   275, true, 450, 8.25, true, NULL, NULL, NULL, NULL);
