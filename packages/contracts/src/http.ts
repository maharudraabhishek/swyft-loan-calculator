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

export const moneySchema = z
  .string()
  .regex(moneyPattern, 'Use a dollar amount such as 1234.50');
export const positiveMoneySchema = moneySchema.refine(
  (value) => Number(value) > 0,
  'Must be greater than zero',
);
/** Annual rate or proportion from 0 to 1 with at most ten decimals. */
export const fractionSchema = z
  .string()
  .regex(fractionPattern, 'Use a decimal fraction from 0 to 1, e.g. 0.085');
export const uuidSchema = z.uuid();
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

export const commissionModelSchema = z.enum([
  'capitalised',
  'overs',
  'loaded',
  'daily_interest',
]);
export const paymentTimingSchema = z.enum(['advance', 'arrears']);
export const interestMethodSchema = z.enum(['monthly', 'daily']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
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

export const loginStartQuerySchema = z.strictObject({
  redirect_uri: loopbackRedirectSchema,
  state: base64UrlSchema(22, 128),
  code_challenge: base64UrlSchema(43, 43),
  code_challenge_method: z.literal('S256'),
});

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

export const logoutRequestSchema = z.strictObject({
  refreshToken: base64UrlSchema(20, 128),
});

export const userSchema = z.strictObject({
  id: uuidSchema,
  email: z.string(),
  displayName: z.string().nullable(),
});
export type UserDto = z.infer<typeof userSchema>;

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
export const dealWriteSchema = z.strictObject({ name: nameSchema(200) });
export type DealWriteDto = z.infer<typeof dealWriteSchema>;

export const dealSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  quoteLogId: uuidSchema,
  quoteCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DealDto = z.infer<typeof dealSchema>;

export const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export const lenderFeeKindSchema = z.enum([
  'establishment',
  'ppsrRegistration',
  'ppsrSearch',
  'privateSale',
]);

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

export const quoteUpdateSchema = z.strictObject({ notes: textSchema(2000) });

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
export const lenderCreateSchema = z.strictObject({
  name: nameSchema(120),
  websiteUrl: httpsUrlSchema.nullable().default(null),
});
export const lenderUpdateSchema = z
  .strictObject({
    name: nameSchema(120).optional(),
    websiteUrl: httpsUrlSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

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

export const feeSignatureCopySchema = z.strictObject({
  copyFromId: uuidSchema,
  name: nameSchema(120).optional(),
});

export const feeSignatureCreateSchema = z.union([
  feeSignatureCopySchema,
  feeSignatureDefinitionSchema,
]);

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
