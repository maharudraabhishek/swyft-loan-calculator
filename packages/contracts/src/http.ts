import { z } from 'zod';

/**
 * HTTP `/v1` contracts shared by the API (request validation) and Electron Main
 * (response validation). Shared schemas do not imply shared trust: each side
 * validates what it receives. Objects are strict, so unknown keys (for example an
 * owner ID or a calculated amount) are rejected rather than silently accepted.
 *
 * Units: money is a decimal-string dollar amount with up to two decimals; rates and
 * fractions are decimal strings (`"0.085"` = 8.5% p.a.); dates are ISO `YYYY-MM-DD`.
 */

// At most $999,999,999.99, leaving numeric(14,2) headroom for derived totals such as hiring.
const moneyPattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;
const fractionPattern = /^(?:0(?:\.\d{1,10})?|1(?:\.0{1,10})?)$/;

/** Dollar amount as a string: 0 to 999,999,999.99, at most two decimals. */
export const moneySchema = z
  .string()
  .regex(moneyPattern, 'Use a dollar amount such as 1234.50');
/** A {@link moneySchema} amount greater than zero. */
export const positiveMoneySchema = moneySchema.refine(
  (value) => Number(value) > 0,
  'Must be greater than zero',
);
/** Annual rate or proportion from 0 to 1 with at most ten decimals. */
export const fractionSchema = z
  .string()
  .regex(fractionPattern, 'Use a decimal fraction from 0 to 1, e.g. 0.085');
/** Record identifiers are UUIDs. */
export const uuidSchema = z.uuid();
/** A real calendar date as `YYYY-MM-DD` (2026-02-30 is rejected). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
    );
  }, 'Use a real calendar date (YYYY-MM-DD)');
const nameSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Required')
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value), 'Invalid characters');
const textSchema = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      // Control characters other than tab, newline and carriage return.
      (value) => !/[^\P{Cc}\t\n\r]/u.test(value),
      'Invalid characters',
    );
const httpsUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(240)
  .refine((value) => !/\s/.test(value));

/** The four commission models in the brief (see packages/finance/README.md, "Commission models"). */
export const commissionModelSchema = z.enum([
  'capitalised',
  'overs',
  'loaded',
  'daily_interest',
]);
/** First instalment at settlement (`advance`) or one period later (`arrears`). */
export const paymentTimingSchema = z.enum(['advance', 'arrears']);
/** Monthly compounding or daily interest over actual days. */
export const interestMethodSchema = z.enum(['monthly', 'daily']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/** Machine-readable error codes; the HTTP status carries the same meaning. */
export const apiErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/**
 * Every error response: a code, a safe message, the request ID for support, and
 * optional per-field validation messages keyed by request field.
 */
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiErrorDto = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
/** RFC 8252 loopback redirect; the only redirect target the API will use. */
export const loopbackRedirectSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
      Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65_535 &&
      url.pathname === '/callback' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.href === value
    );
  } catch {
    return false;
  }
}, 'Must be http://127.0.0.1:<port>/callback');
const base64UrlSchema = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** Query for `GET /v1/auth/login`: the app's loopback address, `state` and PKCE S256 challenge. */
export const loginStartQuerySchema = z.strictObject({
  redirect_uri: loopbackRedirectSchema,
  state: base64UrlSchema(22, 128),
  code_challenge: base64UrlSchema(43, 43),
  code_challenge_method: z.literal('S256'),
});

/**
 * Body for `POST /v1/auth/token`: exchange the single-use sign-in code (with the PKCE
 * verifier) or a refresh token for a new token pair.
 */
export const tokenRequestSchema = z.discriminatedUnion('grantType', [
  z.strictObject({
    grantType: z.literal('authorization_code'),
    code: base64UrlSchema(20, 128),
    codeVerifier: base64UrlSchema(43, 128),
    redirectUri: loopbackRedirectSchema,
  }),
  z.strictObject({
    grantType: z.literal('refresh_token'),
    refreshToken: base64UrlSchema(20, 128),
  }),
]);
export type TokenRequestDto = z.infer<typeof tokenRequestSchema>;

/** Body for `POST /v1/auth/logout`: the refresh token of the session to revoke. */
export const logoutRequestSchema = z.strictObject({
  refreshToken: base64UrlSchema(20, 128),
});

/** The signed-in user as the API describes them. */
export const userSchema = z.strictObject({
  id: uuidSchema,
  email: z.string(),
  displayName: z.string().nullable(),
});
export type UserDto = z.infer<typeof userSchema>;

/** A new token pair. The access token is short-lived; the refresh token rotates on use. */
export const tokenResponseSchema = z.strictObject({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.iso.datetime({ offset: true }),
  user: userSchema,
});
export type TokenResponseDto = z.infer<typeof tokenResponseSchema>;

// ---------------------------------------------------------------------------
// Deals and quotes
// ---------------------------------------------------------------------------
/** Body for creating or renaming a deal. */
export const dealWriteSchema = z.strictObject({ name: nameSchema(200) });
export type DealWriteDto = z.infer<typeof dealWriteSchema>;

/** A deal with its quote log ID and how many quotes the log holds. */
export const dealSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  quoteLogId: uuidSchema,
  quoteCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DealDto = z.infer<typeof dealSchema>;

/** Keyset pagination: page size (1–100, default 50) and an opaque cursor. */
export const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

/** Lender fee types a fee signature can carry. */
export const lenderFeeKindSchema = z.enum([
  'establishment',
  'ppsrRegistration',
  'ppsrSearch',
  'privateSale',
]);

/**
 * What a broker chooses for one quote. It never carries calculated amounts: the API
 * recalculates every figure from these choices and the stored fee signature.
 */
export const quoteCreateSchema = z.strictObject({
  feeSignatureId: uuidSchema,
  assetDescription: textSchema(200).default(''),
  financeAmount: positiveMoneySchema,
  termMonths: z.number().int().min(1).max(600),
  baseRate: fractionSchema,
  commissionRate: fractionSchema.optional(),
  contractRate: fractionSchema.optional(),
  balloon: moneySchema.default('0'),
  originationFee: moneySchema.default('0'),
  originationFinanced: z.boolean().default(true),
  feeFinancing: z
    .strictObject({
      establishment: z.boolean().optional(),
      ppsrRegistration: z.boolean().optional(),
      ppsrSearch: z.boolean().optional(),
      privateSale: z.boolean().optional(),
    })
    .default({}),
  settlementDate: isoDateSchema.optional(),
  firstRepaymentDate: isoDateSchema.optional(),
  notes: textSchema(2000).default(''),
});
export type QuoteCreateDto = z.input<typeof quoteCreateSchema>;
export type QuoteCreateParsed = z.output<typeof quoteCreateSchema>;

/** Only a quote's notes can change; its figures are immutable. */
export const quoteUpdateSchema = z.strictObject({ notes: textSchema(2000) });

/**
 * A saved quote: the broker's choices plus the server-calculated figures (money to the
 * cent, rates as decimal fractions).
 */
export const quoteSchema = z.strictObject({
  id: uuidSchema,
  dealId: uuidSchema,
  quoteLogId: uuidSchema,
  feeSignatureId: uuidSchema.nullable(),
  lenderName: z.string(),
  feeSignatureName: z.string(),
  feeSignatureVersion: z.number().int(),
  commissionModel: commissionModelSchema,
  interestMethod: interestMethodSchema,
  paymentTiming: paymentTimingSchema,
  assetDescription: z.string(),
  financeAmount: z.string(),
  termMonths: z.number().int(),
  balloon: z.string(),
  baseRate: z.string(),
  contractRate: z.string().nullable(),
  commissionRate: z.string().nullable(),
  comparisonRate: z.string().nullable(),
  lenderFee: z.string(),
  originationFee: z.string(),
  monthlyFee: z.string(),
  upfrontFees: z.string(),
  netAmountFinanced: z.string(),
  amountFinanced: z.string(),
  monthlyPayment: z.string(),
  grossMonthlyPayment: z.string(),
  commission: z.string().nullable(),
  totalHiring: z.string(),
  engineVersion: z.string(),
  notes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type QuoteDto = z.infer<typeof quoteSchema>;

// ---------------------------------------------------------------------------
// Lenders and fee signatures
// ---------------------------------------------------------------------------
/** Body for adding the broker's own lender (website must be https). */
export const lenderCreateSchema = z.strictObject({
  name: nameSchema(120),
  websiteUrl: httpsUrlSchema.nullable().default(null),
});
/** Partial update of the broker's own lender; at least one field. */
export const lenderUpdateSchema = z
  .strictObject({
    name: nameSchema(120).optional(),
    websiteUrl: httpsUrlSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** A built-in or the broker's own lender; logos are fetched separately. */
export const lenderSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  websiteUrl: z.string().nullable(),
  isPreset: z.boolean(),
  hasLogo: z.boolean(),
  logoUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LenderDto = z.infer<typeof lenderSchema>;

const lenderFeeSchema = z.strictObject({
  amount: moneySchema,
  financed: z.boolean(),
});

/**
 * A fee signature as the broker defines it (create or replace). Model parameters must
 * match the commission model; the API checks that and answers with field messages.
 */
export const feeSignatureDefinitionSchema = z.strictObject({
  lenderId: uuidSchema,
  name: nameSchema(120),
  commissionModel: commissionModelSchema,
  paymentTiming: paymentTimingSchema,
  defaultCommissionRate: fractionSchema.nullable().default(null),
  maxCommissionRate: fractionSchema.nullable().default(null),
  baseCommission: moneySchema.nullable().default(null),
  oversShare: fractionSchema.nullable().default(null),
  gstRate: fractionSchema.nullable().default(null),
  loadingFactor: fractionSchema.nullable().default(null),
  rateMarkupFactor: fractionSchema.nullable().default(null),
  monthlyFee: moneySchema.default('0'),
  slidingFee: moneySchema.default('0'),
  maxBrokerOrigination: moneySchema.nullable().default(null),
  /**
   * Lender rounds the repayment up to the next whole dollar. Optional so older app
   * versions (which never send it) keep working: omitted on create means off, omitted on
   * update keeps the stored value.
   */
  roundPaymentUpToDollar: z.boolean().optional(),
  fees: z
    .strictObject({
      establishment: lenderFeeSchema
        .extend({ maxAmount: moneySchema.optional() })
        .optional(),
      ppsrRegistration: lenderFeeSchema.optional(),
      ppsrSearch: lenderFeeSchema.optional(),
      privateSale: lenderFeeSchema.optional(),
    })
    .default({}),
});
export type FeeSignatureDefinitionParsed = z.output<
  typeof feeSignatureDefinitionSchema
>;

/** Create a fee signature by copying an existing one (optionally renamed). */
export const feeSignatureCopySchema = z.strictObject({
  copyFromId: uuidSchema,
  name: nameSchema(120).optional(),
});

/** Body for `POST /v1/fee-signatures`: a copy request or a full definition. */
export const feeSignatureCreateSchema = z.union([
  feeSignatureCopySchema,
  feeSignatureDefinitionSchema,
]);

/**
 * A lender product ("fee signature"): its fees, commission model, timing and version.
 * Built-in signatures are read-only (`isPreset`); custom ones link to their source.
 */
export const feeSignatureSchema = z.strictObject({
  id: uuidSchema,
  lenderId: uuidSchema,
  lenderName: z.string(),
  name: z.string(),
  isPreset: z.boolean(),
  sourceFeeSignatureId: uuidSchema.nullable(),
  commissionModel: commissionModelSchema,
  interestMethod: interestMethodSchema,
  paymentTiming: paymentTimingSchema,
  defaultCommissionRate: z.string().nullable(),
  maxCommissionRate: z.string().nullable(),
  baseCommission: z.string().nullable(),
  oversShare: z.string().nullable(),
  gstRate: z.string().nullable(),
  loadingFactor: z.string().nullable(),
  rateMarkupFactor: z.string().nullable(),
  monthlyFee: z.string(),
  slidingFee: z.string(),
  maxBrokerOrigination: z.string().nullable(),
  /**
   * Present (and `true`) only when the lender rounds repayments up to a whole dollar.
   * The API omits it otherwise, because app versions that predate the field parse
   * responses strictly and would reject an unknown key.
   */
  roundPaymentUpToDollar: z.boolean().optional(),
  fees: z.strictObject({
    establishment: z
      .strictObject({
        amount: z.string(),
        financed: z.boolean(),
        maxAmount: z.string().optional(),
      })
      .optional(),
    ppsrRegistration: z
      .strictObject({ amount: z.string(), financed: z.boolean() })
      .optional(),
    ppsrSearch: z
      .strictObject({ amount: z.string(), financed: z.boolean() })
      .optional(),
    privateSale: z
      .strictObject({ amount: z.string(), financed: z.boolean() })
      .optional(),
  }),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FeeSignatureDto = z.infer<typeof feeSignatureSchema>;

/** Keyset-paginated list envelope. */
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
