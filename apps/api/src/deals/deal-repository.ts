import type { DealDto, QuoteDto } from '@swyft/contracts';
import type { JsonValue } from '@swyft/quoting';
import type { Sql } from '../db/database.js';
import { canonicalDecimal } from '../db/decimal-text.js';

/** SQL and row mapping for deals, their quote log and quotes. RLS scopes every read. */

interface DealRow {
  id: string;
  name: string;
  quote_log_id: string;
  quote_count: number;
  created_at: Date;
  updated_at: Date;
}

interface QuoteRow {
  id: string;
  deal_id: string;
  quote_log_id: string;
  fee_signature_id: string | null;
  lender_name: string;
  fee_signature_name: string;
  fee_signature_version: number;
  commission_model: QuoteDto['commissionModel'];
  interest_method: QuoteDto['interestMethod'];
  payment_timing: QuoteDto['paymentTiming'];
  asset_description: string;
  finance_amount: string;
  term_months: number;
  balloon: string;
  base_rate: string;
  contract_rate: string | null;
  commission_rate: string | null;
  comparison_rate: string | null;
  lender_fee: string;
  origination_fee: string;
  monthly_fee: string;
  upfront_fees: string;
  net_amount_financed: string;
  amount_financed: string;
  monthly_payment: string;
  gross_monthly_payment: string;
  commission: string | null;
  total_hiring: string;
  engine_version: string;
  notes: string;
  created_at: Date;
  updated_at: Date;
}

const dealSelect = `SELECT d.id, d.name, q.id AS quote_log_id, d.created_at, d.updated_at,
    (SELECT count(*)::int FROM app.quotes x WHERE x.quote_log_id = q.id) AS quote_count
  FROM app.deals d JOIN app.quote_logs q ON q.deal_id = d.id`;

const quoteSelect = `SELECT x.id, q.deal_id, x.quote_log_id, x.fee_signature_id, x.lender_name,
    x.fee_signature_name, x.fee_signature_version, x.commission_model, x.interest_method,
    x.payment_timing, x.asset_description, x.finance_amount, x.term_months, x.balloon, x.base_rate,
    x.contract_rate, x.commission_rate, x.comparison_rate, x.lender_fee, x.origination_fee,
    x.monthly_fee, x.upfront_fees, x.net_amount_financed, x.amount_financed, x.monthly_payment,
    x.gross_monthly_payment, x.commission, x.total_hiring, x.engine_version, x.notes,
    x.created_at, x.updated_at
  FROM app.quotes x JOIN app.quote_logs q ON q.id = x.quote_log_id`;

function toDealDto(row: DealRow): DealDto {
  return {
    id: row.id,
    name: row.name,
    quoteLogId: row.quote_log_id,
    quoteCount: row.quote_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toQuoteDto(row: QuoteRow): QuoteDto {
  return {
    id: row.id,
    dealId: row.deal_id,
    quoteLogId: row.quote_log_id,
    feeSignatureId: row.fee_signature_id,
    lenderName: row.lender_name,
    feeSignatureName: row.fee_signature_name,
    feeSignatureVersion: row.fee_signature_version,
    commissionModel: row.commission_model,
    interestMethod: row.interest_method,
    paymentTiming: row.payment_timing,
    assetDescription: row.asset_description,
    financeAmount: row.finance_amount,
    termMonths: row.term_months,
    balloon: row.balloon,
    baseRate: canonicalDecimal(row.base_rate),
    contractRate: canonicalDecimal(row.contract_rate),
    commissionRate: canonicalDecimal(row.commission_rate),
    comparisonRate: canonicalDecimal(row.comparison_rate),
    lenderFee: row.lender_fee,
    originationFee: row.origination_fee,
    monthlyFee: row.monthly_fee,
    upfrontFees: row.upfront_fees,
    netAmountFinanced: row.net_amount_financed,
    amountFinanced: row.amount_financed,
    monthlyPayment: row.monthly_payment,
    grossMonthlyPayment: row.gross_monthly_payment,
    commission: row.commission,
    totalHiring: row.total_hiring,
    engineVersion: row.engine_version,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Position in the deal list: the last row's `updated_at` and ID (keyset pagination). */
export interface DealCursor {
  readonly updatedAt: string;
  readonly id: string;
}

/** Newest activity first; `(updated_at, id)` keyset keeps pages stable under inserts. */
export async function listDeals(
  sql: Sql,
  limit: number,
  after: DealCursor | undefined,
): Promise<{
  items: DealDto[];
  last: DealCursor | undefined;
  hasMore: boolean;
}> {
  const rows = await sql.query<DealRow>(
    `${dealSelect}
     WHERE ($1::timestamptz IS NULL OR (d.updated_at, d.id) < ($1::timestamptz, $2::uuid))
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT $3`,
    [after?.updatedAt ?? null, after?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const lastRow = page.at(-1);
  return {
    items: page.map(toDealDto),
    last: lastRow && {
      updatedAt: lastRow.updated_at.toISOString(),
      id: lastRow.id,
    },
    hasMore: rows.length > limit,
  };
}

/** One deal with its quote count, or `undefined` (RLS hides other users' deals). */
export async function findDeal(
  sql: Sql,
  id: string,
): Promise<DealDto | undefined> {
  const rows = await sql.query<DealRow>(`${dealSelect} WHERE d.id = $1`, [id]);
  return rows[0] && toDealDto(rows[0]);
}

/** Deal and its quote log in the caller's transaction (atomic). */
export async function insertDeal(
  sql: Sql,
  ownerUserId: string,
  name: string,
): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    'INSERT INTO app.deals (owner_user_id, name) VALUES ($1, $2) RETURNING id',
    [ownerUserId, name],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Deal insert returned no row');
  await sql.query(
    'INSERT INTO app.quote_logs (owner_user_id, deal_id) VALUES ($1, $2)',
    [ownerUserId, id],
  );
  return id;
}

/** Renames the caller's deal. @returns false if it does not exist or is not theirs. */
export async function renameOwnDeal(
  sql: Sql,
  ownerUserId: string,
  id: string,
  name: string,
): Promise<boolean> {
  const rows = await sql.query(
    `UPDATE app.deals SET name = $3, updated_at = now()
     WHERE id = $1 AND owner_user_id = $2 RETURNING id`,
    [id, ownerUserId, name],
  );
  return rows.length === 1;
}

/** Deletes the caller's deal; its quote log and quotes go with it (cascade). */
export async function deleteOwnDeal(
  sql: Sql,
  ownerUserId: string,
  id: string,
): Promise<boolean> {
  const rows = await sql.query(
    'DELETE FROM app.deals WHERE id = $1 AND owner_user_id = $2 RETURNING id',
    [id, ownerUserId],
  );
  return rows.length === 1;
}

/** Marks a deal as recently active so it sorts first in the list. */
export async function touchDeal(sql: Sql, dealId: string): Promise<void> {
  await sql.query('UPDATE app.deals SET updated_at = now() WHERE id = $1', [
    dealId,
  ]);
}

/** All quotes in a deal's log, oldest first. */
export async function listQuotes(
  sql: Sql,
  dealId: string,
): Promise<QuoteDto[]> {
  const rows = await sql.query<QuoteRow>(
    `${quoteSelect} WHERE q.deal_id = $1 ORDER BY x.created_at, x.id`,
    [dealId],
  );
  return rows.map(toQuoteDto);
}

/** One quote, or `undefined` (RLS hides other users' quotes). */
export async function findQuote(
  sql: Sql,
  id: string,
): Promise<QuoteDto | undefined> {
  const rows = await sql.query<QuoteRow>(`${quoteSelect} WHERE x.id = $1`, [
    id,
  ]);
  return rows[0] && toQuoteDto(rows[0]);
}

/**
 * The caller's earlier quote saved with this idempotency key, with the hash of that
 * request, so a retry can be recognised (same hash) or refused (different hash).
 */
export async function findQuoteByIdempotencyKey(
  sql: Sql,
  ownerUserId: string,
  key: string,
): Promise<{ id: string; requestSha256: Buffer } | undefined> {
  const rows = await sql.query<{ id: string; request_sha256: Buffer }>(
    'SELECT id, request_sha256 FROM app.quotes WHERE owner_user_id = $1 AND idempotency_key = $2',
    [ownerUserId, key],
  );
  const row = rows[0];
  return row && { id: row.id, requestSha256: row.request_sha256 };
}

/** Column values of an immutable quote snapshot. */
export interface QuoteSnapshot {
  readonly feeSignatureId: string;
  readonly lenderName: string;
  readonly feeSignatureName: string;
  readonly feeSignatureVersion: number;
  readonly commissionModel: string;
  readonly interestMethod: string;
  readonly paymentTiming: string;
  readonly assetDescription: string;
  readonly financeAmount: string;
  readonly termMonths: number;
  readonly balloon: string;
  readonly baseRate: string;
  readonly contractRate: string | null;
  readonly commissionRate: string | null;
  readonly comparisonRate: string | null;
  readonly lenderFee: string;
  readonly originationFee: string;
  readonly monthlyFee: string;
  readonly upfrontFees: string;
  readonly netAmountFinanced: string;
  readonly amountFinanced: string;
  readonly monthlyPayment: string;
  readonly grossMonthlyPayment: string;
  readonly commission: string | null;
  readonly totalHiring: string;
  readonly calculationInput: JsonValue;
  readonly calculationResult: JsonValue;
  readonly feeSignatureSnapshot: JsonValue;
  readonly engineVersion: string;
  readonly notes: string;
}

/** Stores a recalculated quote and its immutable snapshot. @returns the new quote ID. */
export async function insertQuote(
  sql: Sql,
  ownerUserId: string,
  quoteLogId: string,
  idempotency: { key: string; requestSha256: Buffer },
  quote: QuoteSnapshot,
): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `INSERT INTO app.quotes (
       owner_user_id, quote_log_id, idempotency_key, request_sha256, fee_signature_id,
       lender_name, fee_signature_name, fee_signature_version, commission_model, interest_method,
       payment_timing, asset_description, finance_amount, term_months, balloon, base_rate,
       contract_rate, commission_rate, comparison_rate, lender_fee, origination_fee, monthly_fee,
       upfront_fees, net_amount_financed, amount_financed, monthly_payment, gross_monthly_payment,
       commission, total_hiring, calculation_input, calculation_result, fee_signature_snapshot,
       engine_version, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
       $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30::jsonb, $31::jsonb, $32::jsonb, $33, $34)
     RETURNING id`,
    [
      ownerUserId,
      quoteLogId,
      idempotency.key,
      idempotency.requestSha256,
      quote.feeSignatureId,
      quote.lenderName,
      quote.feeSignatureName,
      quote.feeSignatureVersion,
      quote.commissionModel,
      quote.interestMethod,
      quote.paymentTiming,
      quote.assetDescription,
      quote.financeAmount,
      quote.termMonths,
      quote.balloon,
      quote.baseRate,
      quote.contractRate,
      quote.commissionRate,
      quote.comparisonRate,
      quote.lenderFee,
      quote.originationFee,
      quote.monthlyFee,
      quote.upfrontFees,
      quote.netAmountFinanced,
      quote.amountFinanced,
      quote.monthlyPayment,
      quote.grossMonthlyPayment,
      quote.commission,
      quote.totalHiring,
      JSON.stringify(quote.calculationInput),
      JSON.stringify(quote.calculationResult),
      JSON.stringify(quote.feeSignatureSnapshot),
      quote.engineVersion,
      quote.notes,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Quote insert returned no row');
  return id;
}

/** Replaces the notes on the caller's quote (the only editable part of a quote). */
export async function updateOwnQuoteNotes(
  sql: Sql,
  ownerUserId: string,
  id: string,
  notes: string,
): Promise<boolean> {
  const rows = await sql.query(
    `UPDATE app.quotes SET notes = $3, updated_at = now()
     WHERE id = $1 AND owner_user_id = $2 RETURNING id`,
    [id, ownerUserId, notes],
  );
  return rows.length === 1;
}

/** Deletes one of the caller's quotes. @returns false if not found. */
export async function deleteOwnQuote(
  sql: Sql,
  ownerUserId: string,
  id: string,
): Promise<boolean> {
  const rows = await sql.query(
    'DELETE FROM app.quotes WHERE id = $1 AND owner_user_id = $2 RETURNING id',
    [id, ownerUserId],
  );
  return rows.length === 1;
}

/** Clears a quote log ("Clear all quotes"). @returns how many quotes were deleted. */
export async function deleteQuotesOfLog(
  sql: Sql,
  ownerUserId: string,
  quoteLogId: string,
): Promise<number> {
  const rows = await sql.query(
    'DELETE FROM app.quotes WHERE quote_log_id = $1 AND owner_user_id = $2 RETURNING id',
    [quoteLogId, ownerUserId],
  );
  return rows.length;
}
