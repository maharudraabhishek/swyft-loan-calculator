import type {
  FeeSignatureDefinitionParsed,
  FeeSignatureDto,
  LenderDto,
} from '@swyft/contracts';
import { Fraction, Money } from '@swyft/finance';
import type { FeeSignature, LenderFee, LenderFeeKind } from '@swyft/quoting';
import type { Sql } from '../db/database.js';
import { canonicalDecimal } from '../db/decimal-text.js';

/**
 * SQL and row mapping for lenders and fee signatures. Every statement runs inside a
 * `withUser` transaction, so RLS limits rows to the caller's own plus presets; write
 * statements additionally filter on the owner so a preset or foreign ID matches nothing.
 */

interface LenderRow {
  id: string;
  owner_user_id: string | null;
  name: string;
  website_url: string | null;
  logo_object_key: string | null;
  logo_content_type: string | null;
  logo_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A `fee_signatures` row joined with its lender's name. */
export interface FeeSignatureRow {
  id: string;
  owner_user_id: string | null;
  lender_id: string;
  lender_name: string;
  source_fee_signature_id: string | null;
  name: string;
  commission_model: FeeSignatureDto['commissionModel'];
  interest_method: FeeSignatureDto['interestMethod'];
  payment_timing: FeeSignatureDto['paymentTiming'];
  default_commission_rate: string | null;
  max_commission_rate: string | null;
  base_commission: string | null;
  overs_share: string | null;
  gst_rate: string | null;
  loading_factor: string | null;
  rate_markup_factor: string | null;
  monthly_fee: string;
  sliding_fee: string;
  max_broker_origination: string | null;
  establishment_fee: string | null;
  establishment_financed: boolean | null;
  establishment_fee_max: string | null;
  ppsr_registration_fee: string | null;
  ppsr_registration_financed: boolean | null;
  ppsr_search_fee: string | null;
  ppsr_search_financed: boolean | null;
  private_sale_fee: string | null;
  private_sale_financed: boolean | null;
  round_payment_up_to_dollar: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const lenderColumns = `id, owner_user_id, name, website_url, logo_object_key, logo_content_type,
  logo_updated_at, created_at, updated_at`;

const signatureColumns = `f.id, f.owner_user_id, f.lender_id, l.name AS lender_name, f.source_fee_signature_id,
  f.name, f.commission_model, f.interest_method, f.payment_timing, f.default_commission_rate,
  f.max_commission_rate, f.base_commission, f.overs_share, f.gst_rate, f.loading_factor,
  f.rate_markup_factor, f.monthly_fee, f.sliding_fee, f.max_broker_origination,
  f.establishment_fee, f.establishment_financed, f.establishment_fee_max,
  f.ppsr_registration_fee, f.ppsr_registration_financed, f.ppsr_search_fee, f.ppsr_search_financed,
  f.private_sale_fee, f.private_sale_financed, f.round_payment_up_to_dollar,
  f.version, f.created_at, f.updated_at`;

/** Where a lender's logo is stored and its image type. */
export interface LenderLogoRef {
  readonly key: string;
  readonly contentType: string;
}

/** Maps a lender row to the API shape (logo location is never exposed). */
export function toLenderDto(row: LenderRow): LenderDto {
  return {
    id: row.id,
    name: row.name,
    websiteUrl: row.website_url,
    isPreset: row.owner_user_id === null,
    hasLogo: row.logo_object_key !== null,
    logoUpdatedAt: row.logo_updated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Built-in lenders plus the caller's own (RLS), presets first. */
export async function listLenders(sql: Sql): Promise<LenderDto[]> {
  const rows = await sql.query<LenderRow>(
    `SELECT ${lenderColumns} FROM app.lenders
     ORDER BY owner_user_id IS NOT NULL, lower(name), id`,
  );
  return rows.map(toLenderDto);
}

/** One lender visible to the caller, or `undefined`. */
export async function findLender(
  sql: Sql,
  id: string,
): Promise<LenderRow | undefined> {
  const rows = await sql.query<LenderRow>(
    `SELECT ${lenderColumns} FROM app.lenders WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Creates one of the caller's own lenders. @returns the new lender ID. */
export async function insertLender(
  sql: Sql,
  ownerUserId: string,
  input: { name: string; websiteUrl: string | null },
): Promise<LenderDto> {
  const rows = await sql.query<LenderRow>(
    `INSERT INTO app.lenders (owner_user_id, name, website_url) VALUES ($1, $2, $3)
     RETURNING ${lenderColumns}`,
    [ownerUserId, input.name, input.websiteUrl],
  );
  const row = rows[0];
  if (!row) throw new Error('Lender insert returned no row');
  return toLenderDto(row);
}

/** Renames or changes the website of the caller's lender. @returns false if not found. */
export async function updateOwnLender(
  sql: Sql,
  ownerUserId: string,
  id: string,
  input: { name?: string | undefined; websiteUrl?: string | null | undefined },
): Promise<LenderDto | undefined> {
  const rows = await sql.query<LenderRow>(
    `UPDATE app.lenders
     SET name = COALESCE($3, name),
         website_url = CASE WHEN $4 THEN $5 ELSE website_url END,
         updated_at = now()
     WHERE id = $1 AND owner_user_id = $2
     RETURNING ${lenderColumns}`,
    [
      id,
      ownerUserId,
      input.name ?? null,
      input.websiteUrl !== undefined,
      input.websiteUrl ?? null,
    ],
  );
  return rows[0] && toLenderDto(rows[0]);
}

/** @returns the removed lender's logo reference, or undefined when nothing was deleted. */
export async function deleteOwnLender(
  sql: Sql,
  ownerUserId: string,
  id: string,
): Promise<{ logo: LenderLogoRef | null } | undefined> {
  const rows = await sql.query<
    Pick<LenderRow, 'logo_object_key' | 'logo_content_type'>
  >(
    `DELETE FROM app.lenders WHERE id = $1 AND owner_user_id = $2
     RETURNING logo_object_key, logo_content_type`,
    [id, ownerUserId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    logo:
      row.logo_object_key && row.logo_content_type
        ? { key: row.logo_object_key, contentType: row.logo_content_type }
        : null,
  };
}

/** Swaps the logo reference on an owned lender; returns the previous key, or undefined if not owned. */
export async function replaceOwnLenderLogo(
  sql: Sql,
  ownerUserId: string,
  id: string,
  logo: LenderLogoRef | null,
): Promise<{ previousKey: string | null } | undefined> {
  const rows = await sql.query<{ previous_key: string | null }>(
    `UPDATE app.lenders AS l
     SET logo_object_key = $3, logo_content_type = $4,
         logo_updated_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
         updated_at = now()
     FROM (SELECT logo_object_key AS previous_key FROM app.lenders
           WHERE id = $1 AND owner_user_id = $2 FOR UPDATE) AS previous
     WHERE l.id = $1 AND l.owner_user_id = $2
     RETURNING previous.previous_key`,
    [id, ownerUserId, logo?.key ?? null, logo?.contentType ?? null],
  );
  const row = rows[0];
  return row ? { previousKey: row.previous_key } : undefined;
}

// ---------------------------------------------------------------------------
// Fee signatures
// ---------------------------------------------------------------------------

function fee(
  amount: string | null,
  financed: boolean | null,
  max?: string | null,
) {
  if (amount === null || financed === null) return undefined;
  return max ? { amount, financed, maxAmount: max } : { amount, financed };
}

/** Maps a stored signature to the API shape. */
export function toFeeSignatureDto(row: FeeSignatureRow): FeeSignatureDto {
  const establishment = fee(
    row.establishment_fee,
    row.establishment_financed,
    row.establishment_fee_max,
  );
  const ppsrRegistration = fee(
    row.ppsr_registration_fee,
    row.ppsr_registration_financed,
  );
  const ppsrSearch = fee(row.ppsr_search_fee, row.ppsr_search_financed);
  const privateSale = fee(row.private_sale_fee, row.private_sale_financed);
  return {
    id: row.id,
    lenderId: row.lender_id,
    lenderName: row.lender_name,
    name: row.name,
    isPreset: row.owner_user_id === null,
    sourceFeeSignatureId: row.source_fee_signature_id,
    commissionModel: row.commission_model,
    interestMethod: row.interest_method,
    paymentTiming: row.payment_timing,
    defaultCommissionRate: canonicalDecimal(row.default_commission_rate),
    maxCommissionRate: canonicalDecimal(row.max_commission_rate),
    baseCommission: row.base_commission,
    oversShare: canonicalDecimal(row.overs_share),
    gstRate: canonicalDecimal(row.gst_rate),
    loadingFactor: canonicalDecimal(row.loading_factor),
    rateMarkupFactor: canonicalDecimal(row.rate_markup_factor),
    monthlyFee: row.monthly_fee,
    slidingFee: row.sliding_fee,
    maxBrokerOrigination: row.max_broker_origination,
    // Present only when true: app versions released before this field existed parse
    // responses strictly and would reject an unknown key on every signature.
    ...(row.round_payment_up_to_dollar && { roundPaymentUpToDollar: true }),
    fees: {
      ...(establishment && { establishment }),
      ...(ppsrRegistration && { ppsrRegistration }),
      ...(ppsrSearch && { ppsrSearch }),
      ...(privateSale && { privateSale }),
    },
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const fraction = (value: string | null) =>
  value === null ? undefined : Fraction.from(value);
const money = (value: string | null) =>
  value === null ? undefined : Money.from(value);

/** Maps a stored signature to the quoting domain used for server recalculation. */
export function toFeeSignatureDomain(row: FeeSignatureRow): FeeSignature {
  const fees: Partial<Record<LenderFeeKind, LenderFee>> = {};
  const add = (
    kind: LenderFeeKind,
    amount: string | null,
    financed: boolean | null,
    max?: string | null,
  ) => {
    if (amount === null || financed === null) return;
    fees[kind] = max
      ? { amount: Money.from(amount), financed, maxAmount: Money.from(max) }
      : { amount: Money.from(amount), financed };
  };
  add(
    'establishment',
    row.establishment_fee,
    row.establishment_financed,
    row.establishment_fee_max,
  );
  add(
    'ppsrRegistration',
    row.ppsr_registration_fee,
    row.ppsr_registration_financed,
  );
  add('ppsrSearch', row.ppsr_search_fee, row.ppsr_search_financed);
  add('privateSale', row.private_sale_fee, row.private_sale_financed);
  const defaultCommissionRate = fraction(row.default_commission_rate);
  const maxCommissionRate = fraction(row.max_commission_rate);
  const baseCommission = money(row.base_commission);
  const oversShare = fraction(row.overs_share);
  const gstRate = fraction(row.gst_rate);
  const loadingFactor = fraction(row.loading_factor);
  const rateMarkupFactor = fraction(row.rate_markup_factor);
  const maxBrokerOrigination = money(row.max_broker_origination);
  return {
    id: row.id,
    version: row.version,
    lenderName: row.lender_name,
    name: row.name,
    commissionModel: row.commission_model,
    interestMethod: row.interest_method,
    paymentTiming: row.payment_timing,
    monthlyFee: Money.from(row.monthly_fee),
    slidingFee: Money.from(row.sliding_fee),
    fees,
    ...(defaultCommissionRate && { defaultCommissionRate }),
    ...(maxCommissionRate && { maxCommissionRate }),
    ...(baseCommission && { baseCommission }),
    ...(oversShare && { oversShare }),
    ...(gstRate && { gstRate }),
    ...(loadingFactor && { loadingFactor }),
    ...(rateMarkupFactor && { rateMarkupFactor }),
    ...(maxBrokerOrigination && { maxBrokerOrigination }),
    ...(row.round_payment_up_to_dollar && { roundPaymentUpToDollar: true }),
  };
}

/** Domain view of an API definition, used to validate model parameters before writing. */
export function definitionToDomain(
  definition: FeeSignatureDefinitionParsed,
  lenderName: string,
): FeeSignature {
  const columns = definitionColumns(definition);
  return toFeeSignatureDomain({
    ...columns,
    round_payment_up_to_dollar: columns.round_payment_up_to_dollar ?? false,
    id: '00000000-0000-4000-8000-000000000000',
    owner_user_id: null,
    lender_name: lenderName,
    source_fee_signature_id: null,
    version: 1,
    created_at: new Date(0),
    updated_at: new Date(0),
  });
}

function definitionColumns(definition: FeeSignatureDefinitionParsed) {
  const { establishment, ppsrRegistration, ppsrSearch, privateSale } =
    definition.fees;
  return {
    lender_id: definition.lenderId,
    name: definition.name,
    commission_model: definition.commissionModel,
    interest_method:
      definition.commissionModel === 'daily_interest'
        ? ('daily' as const)
        : ('monthly' as const),
    payment_timing: definition.paymentTiming,
    default_commission_rate: definition.defaultCommissionRate,
    max_commission_rate: definition.maxCommissionRate,
    base_commission: definition.baseCommission,
    overs_share: definition.oversShare,
    gst_rate: definition.gstRate,
    loading_factor: definition.loadingFactor,
    rate_markup_factor: definition.rateMarkupFactor,
    monthly_fee: definition.monthlyFee,
    sliding_fee: definition.slidingFee,
    max_broker_origination: definition.maxBrokerOrigination,
    establishment_fee: establishment?.amount ?? null,
    establishment_financed: establishment?.financed ?? null,
    establishment_fee_max: establishment?.maxAmount ?? null,
    ppsr_registration_fee: ppsrRegistration?.amount ?? null,
    ppsr_registration_financed: ppsrRegistration?.financed ?? null,
    ppsr_search_fee: ppsrSearch?.amount ?? null,
    ppsr_search_financed: ppsrSearch?.financed ?? null,
    private_sale_fee: privateSale?.amount ?? null,
    private_sale_financed: privateSale?.financed ?? null,
    // `null` = not sent: a new signature stores false, an update keeps the stored value.
    round_payment_up_to_dollar: definition.roundPaymentUpToDollar ?? null,
  };
}

const writableColumns = [
  'lender_id',
  'name',
  'commission_model',
  'interest_method',
  'payment_timing',
  'default_commission_rate',
  'max_commission_rate',
  'base_commission',
  'overs_share',
  'gst_rate',
  'loading_factor',
  'rate_markup_factor',
  'monthly_fee',
  'sliding_fee',
  'max_broker_origination',
  'establishment_fee',
  'establishment_financed',
  'establishment_fee_max',
  'ppsr_registration_fee',
  'ppsr_registration_financed',
  'ppsr_search_fee',
  'ppsr_search_financed',
  'private_sale_fee',
  'private_sale_financed',
  'round_payment_up_to_dollar',
] as const;

type WritableColumns = Record<(typeof writableColumns)[number], unknown>;

function columnsFromRow(row: FeeSignatureRow): WritableColumns {
  return Object.fromEntries(
    writableColumns.map((column) => [column, row[column]]),
  ) as WritableColumns;
}

/** Built-in signatures plus the caller's own, presets first, then by lender and name. */
export async function listFeeSignatures(sql: Sql): Promise<FeeSignatureDto[]> {
  const rows = await sql.query<FeeSignatureRow>(
    `SELECT ${signatureColumns} FROM app.fee_signatures f JOIN app.lenders l ON l.id = f.lender_id
     ORDER BY f.owner_user_id IS NOT NULL, lower(l.name), lower(f.name), f.id`,
  );
  return rows.map(toFeeSignatureDto);
}

/** One signature visible to the caller, or `undefined`. */
export async function findFeeSignature(
  sql: Sql,
  id: string,
): Promise<FeeSignatureRow | undefined> {
  const rows = await sql.query<FeeSignatureRow>(
    `SELECT ${signatureColumns} FROM app.fee_signatures f JOIN app.lenders l ON l.id = f.lender_id
     WHERE f.id = $1`,
    [id],
  );
  return rows[0];
}

async function insertColumns(
  sql: Sql,
  ownerUserId: string,
  sourceId: string | null,
  columns: WritableColumns,
): Promise<string> {
  const names = [...writableColumns];
  const values = names.map((name) => columns[name]);
  const rows = await sql.query<{ id: string }>(
    `INSERT INTO app.fee_signatures (owner_user_id, source_fee_signature_id, ${names.join(', ')})
     VALUES ($1, $2, ${names.map((_, index) => `$${index + 3}`).join(', ')})
     RETURNING id`,
    [ownerUserId, sourceId, ...values],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Fee signature insert returned no row');
  return id;
}

/** Creates the caller's own signature from a full definition. @returns its ID. */
export function insertFeeSignature(
  sql: Sql,
  ownerUserId: string,
  definition: FeeSignatureDefinitionParsed,
): Promise<string> {
  const columns = definitionColumns(definition);
  return insertColumns(sql, ownerUserId, null, {
    ...columns,
    round_payment_up_to_dollar: columns.round_payment_up_to_dollar ?? false,
  });
}

/** Creates the caller's own copy of a signature (linked to its source). @returns its ID. */
export function copyFeeSignature(
  sql: Sql,
  ownerUserId: string,
  source: FeeSignatureRow,
  name: string,
): Promise<string> {
  return insertColumns(sql, ownerUserId, source.id, {
    ...columnsFromRow(source),
    name,
  });
}

/** Replaces the caller's own signature and bumps its version. @returns false if not found. */
export async function updateOwnFeeSignature(
  sql: Sql,
  ownerUserId: string,
  id: string,
  definition: FeeSignatureDefinitionParsed,
): Promise<boolean> {
  const columns = definitionColumns(definition);
  const names = [...writableColumns];
  const rows = await sql.query<{ id: string }>(
    `UPDATE app.fee_signatures
     SET ${names
       .map((name, index) =>
         // Older app versions do not send the rounding flag; keep what is stored.
         name === 'round_payment_up_to_dollar'
           ? `${name} = COALESCE($${index + 3}, ${name})`
           : `${name} = $${index + 3}`,
       )
       .join(', ')},
         version = version + 1, updated_at = now()
     WHERE id = $1 AND owner_user_id = $2
     RETURNING id`,
    [id, ownerUserId, ...names.map((name) => columns[name])],
  );
  return rows.length === 1;
}

/** Deletes the caller's own signature; saved quotes keep their snapshot. @returns false if not found. */
export async function deleteOwnFeeSignature(
  sql: Sql,
  ownerUserId: string,
  id: string,
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    'DELETE FROM app.fee_signatures WHERE id = $1 AND owner_user_id = $2 RETURNING id',
    [id, ownerUserId],
  );
  return rows.length === 1;
}
