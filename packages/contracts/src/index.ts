import { z } from 'zod';
import {
  feeSignatureSchema,
  isoDateSchema,
  moneySchema,
  quoteCreateSchema,
  quoteSchema,
  type DealDto,
  type FeeSignatureDto,
  type LenderDto,
  type QuoteCreateDto,
  type QuoteDto,
  type feeSignatureDefinitionSchema,
} from './http.js';

/**
 * IPC contracts between Preload/Renderer and Main. They are separate from the HTTP
 * contracts in `http.ts`: Main re-validates every IPC argument (the Renderer is
 * untrusted) and never forwards a token or raw response across the bridge.
 */
export type DecimalString = string;

export interface ScheduleRowDto {
  readonly paymentNumber: number;
  readonly paymentDate?: string;
  readonly openingBalanceDollars: DecimalString;
  readonly interestDollars: DecimalString;
  readonly principalDollars: DecimalString;
  readonly feesDollars: DecimalString;
  readonly paymentDollars: DecimalString;
  readonly closingBalanceDollars: DecimalString;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
export type AuthStatus =
  'restoring' | 'signed-out' | 'signing-in' | 'signed-in' | 'offline';

/** Everything the Renderer learns about the session. Tokens never cross IPC. */
export interface AuthStateDto {
  readonly status: AuthStatus;
  readonly user?: {
    readonly email: string;
    readonly displayName: string | null;
  };
  /** A safe, user-facing explanation (e.g. why sign-in stopped). */
  readonly message?: string;
  /** False when the OS offers no secure storage, so sign-in will not be remembered. */
  readonly remembersSession: boolean;
}

/** Session capabilities. None take arguments, so the Renderer cannot steer the flow. */
export interface DesktopAuthBridge {
  getState(): Promise<AuthStateDto>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  retry(): Promise<void>;
  /** @returns a function that removes the listener */
  onStateChanged(listener: (state: AuthStateDto) => void): () => void;
}

// ---------------------------------------------------------------------------
// API results over IPC
// ---------------------------------------------------------------------------
/**
 * Why a cloud request failed, in terms the UI can act on. `offline` means no response
 * at all; `server` covers 5xx and malformed responses; `unauthenticated` means the
 * session ended (Main has already moved auth state to signed-out).
 */
export type ApiFailureKind =
  | 'offline'
  | 'unauthenticated'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'server'
  | 'invalid-request';

export interface ApiFailure {
  readonly kind: ApiFailureKind;
  /** Safe, user-facing text; never a stack, SQL or token. */
  readonly message: string;
  /** Field-level messages keyed by request field name (validation only). */
  readonly fields?: Readonly<Record<string, string>>;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiFailure };

// ---------------------------------------------------------------------------
// Bounded decimals for data the Renderer echoes back to Main
// ---------------------------------------------------------------------------
/**
 * Response schemas type decimals as plain strings. When the Renderer sends such data
 * back (preview signature, export quotes), Main re-validates every decimal with a
 * bounded plain-decimal pattern: a value such as "1e1000000000" would otherwise pass
 * Decimal's finiteness check and make formatting build a gigantic string in Main.
 */
const ipcDecimal = z
  .string()
  .regex(/^\d{1,12}(?:\.\d{1,12})?$/, 'Use a plain decimal number');
const ipcFee = z.strictObject({ amount: ipcDecimal, financed: z.boolean() });

const ipcFeeSignatureSchema = feeSignatureSchema.extend({
  defaultCommissionRate: ipcDecimal.nullable(),
  maxCommissionRate: ipcDecimal.nullable(),
  baseCommission: ipcDecimal.nullable(),
  oversShare: ipcDecimal.nullable(),
  gstRate: ipcDecimal.nullable(),
  loadingFactor: ipcDecimal.nullable(),
  rateMarkupFactor: ipcDecimal.nullable(),
  monthlyFee: ipcDecimal,
  slidingFee: ipcDecimal,
  maxBrokerOrigination: ipcDecimal.nullable(),
  fees: z.strictObject({
    establishment: ipcFee
      .extend({ maxAmount: ipcDecimal.optional() })
      .optional(),
    ppsrRegistration: ipcFee.optional(),
    ppsrSearch: ipcFee.optional(),
    privateSale: ipcFee.optional(),
  }),
});

const ipcQuoteSchema = quoteSchema.extend({
  termMonths: z.number().int().min(1).max(600),
  financeAmount: ipcDecimal,
  balloon: ipcDecimal,
  baseRate: ipcDecimal,
  contractRate: ipcDecimal.nullable(),
  commissionRate: ipcDecimal.nullable(),
  comparisonRate: ipcDecimal.nullable(),
  lenderFee: ipcDecimal,
  originationFee: ipcDecimal,
  monthlyFee: ipcDecimal,
  upfrontFees: ipcDecimal,
  netAmountFinanced: ipcDecimal,
  amountFinanced: ipcDecimal,
  monthlyPayment: ipcDecimal,
  grossMonthlyPayment: ipcDecimal,
  commission: ipcDecimal.nullable(),
  totalHiring: ipcDecimal,
  assetDescription: z.string().max(200),
  notes: z.string().max(2000),
});

// ---------------------------------------------------------------------------
// Quote preview (local, never saved)
// ---------------------------------------------------------------------------
/** The signature the broker picked plus their choices, exactly as a save would send. */
export const quotePreviewRequestSchema = z.strictObject({
  signature: ipcFeeSignatureSchema,
  request: quoteCreateSchema,
  scheduleStartDate: isoDateSchema.optional(),
});
export interface QuotePreviewRequestDto {
  readonly signature: FeeSignatureDto;
  readonly request: QuoteCreateDto;
  /**
   * Monthly-model lenders only: settlement date used to date the preview schedule. It is
   * display data and is not part of the saved quote request.
   */
  readonly scheduleStartDate?: string;
}

/** Same field names and rounding as the saved `QuoteDto`, plus the schedule. */
export interface QuotePreviewDto {
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
  readonly schedule: readonly ScheduleRowDto[];
}

export type QuotePreviewResponseDto =
  | { readonly ok: true; readonly preview: QuotePreviewDto }
  | {
      readonly ok: false;
      readonly message: string;
      /** Field-level problems keyed by `QuoteCreateDto` field name. */
      readonly fields: Readonly<Record<string, string>>;
    };

// ---------------------------------------------------------------------------
// Target commission (reverse calculation, local like the preview)
// ---------------------------------------------------------------------------
export const targetCommissionRequestSchema = z.strictObject({
  signature: ipcFeeSignatureSchema,
  request: quoteCreateSchema,
  targetCommission: moneySchema,
});
export interface TargetCommissionRequestDto {
  readonly signature: FeeSignatureDto;
  readonly request: QuoteCreateDto;
  /** Dollars, e.g. "1500". */
  readonly targetCommission: string;
}

/**
 * Overs lenders solve the contract rate; other models solve the commission rate (daily
 * interest also reports the contract rate it produces). Rates are annual fractions;
 * `commission` is what a quote with that rate will earn.
 */
export type TargetCommissionResponseDto =
  | {
      readonly ok: true;
      readonly solves: 'contractRate' | 'commissionRate';
      readonly rate: string;
      readonly commission: string;
      readonly contractRate: string | null;
      readonly metByBaseCommission: boolean;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fields: Readonly<Record<string, string>>;
    };

// ---------------------------------------------------------------------------
// Display preferences and client export
// ---------------------------------------------------------------------------
export const paymentFrequencies = ['monthly', 'fortnightly', 'weekly'] as const;
export type PaymentFrequency = (typeof paymentFrequencies)[number];

/**
 * What the broker chose to show. The same object drives the quote log, the comparison
 * and the client email export (brief: "Display Toggles ... in both").
 */
export const displayOptionsSchema = z.strictObject({
  frequencies: z.strictObject({
    monthly: z.boolean(),
    fortnightly: z.boolean(),
    weekly: z.boolean(),
  }),
  showBaseRate: z.boolean(),
  showComparisonRate: z.boolean(),
  showCommission: z.boolean(),
  showTotalHiring: z.boolean(),
});
export type DisplayOptions = z.infer<typeof displayOptionsSchema>;

export const defaultDisplayOptions: DisplayOptions = {
  frequencies: { monthly: true, fortnightly: false, weekly: false },
  showBaseRate: true,
  showComparisonRate: true,
  showCommission: false,
  showTotalHiring: true,
};

/** Upper bound on quotes per export; one deal's log is far smaller in practice. */
export const maxExportQuotes = 100;

export const quoteExportRequestSchema = z.strictObject({
  quotes: z.array(ipcQuoteSchema).min(1).max(maxExportQuotes),
  display: displayOptionsSchema,
});
export interface QuoteExportRequestDto {
  readonly quotes: readonly QuoteDto[];
  readonly display: DisplayOptions;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------
export interface DealPageDto {
  readonly items: readonly DealDto[];
  readonly nextCursor: string | null;
}

/** Fee-signature fields a broker may edit on their own (custom) signature. */
export type FeeSignatureEditDto = z.input<typeof feeSignatureDefinitionSchema>;

export interface DesktopDealsBridge {
  list(cursor?: string): Promise<ApiResult<DealPageDto>>;
  create(name: string): Promise<ApiResult<DealDto>>;
  rename(dealId: string, name: string): Promise<ApiResult<DealDto>>;
  remove(dealId: string): Promise<ApiResult<null>>;
}

export interface DesktopQuotesBridge {
  list(dealId: string): Promise<ApiResult<readonly QuoteDto[]>>;
  /** `idempotencyKey` must be reused when retrying the same draft. */
  save(
    dealId: string,
    idempotencyKey: string,
    request: QuoteCreateDto,
  ): Promise<ApiResult<QuoteDto>>;
  updateNotes(quoteId: string, notes: string): Promise<ApiResult<QuoteDto>>;
  remove(quoteId: string): Promise<ApiResult<null>>;
  /** Clears the deal's whole quote log. @returns the number deleted. */
  clear(dealId: string): Promise<ApiResult<{ readonly deleted: number }>>;
  /** Local, deterministic calculation with the shared engine. Never saved. */
  preview(request: QuotePreviewRequestDto): Promise<QuotePreviewResponseDto>;
  /** Local reverse calculation: the rate that earns a target commission. */
  targetCommission(
    request: TargetCommissionRequestDto,
  ): Promise<TargetCommissionResponseDto>;
  /** Writes the email-ready HTML and plain text to the system clipboard. */
  copyExport(
    request: QuoteExportRequestDto,
  ): Promise<ApiResult<{ readonly quoteCount: number }>>;
}

export interface DesktopLendersBridge {
  listLenders(): Promise<ApiResult<readonly LenderDto[]>>;
  /** Custom lenders belong to the signed-in broker; presets are read-only. */
  createLender(input: {
    readonly name: string;
    readonly websiteUrl: string | null;
  }): Promise<ApiResult<LenderDto>>;
  updateLender(
    lenderId: string,
    patch: { readonly name?: string; readonly websiteUrl?: string | null },
  ): Promise<ApiResult<LenderDto>>;
  /** Deletes the lender and its custom fee signatures; saved quotes keep their snapshot. */
  removeLender(lenderId: string): Promise<ApiResult<null>>;
  /** The stored logo as a `data:` URL for display. */
  logo(lenderId: string): Promise<ApiResult<{ readonly dataUrl: string }>>;
  /**
   * Main opens the system file picker (PNG, JPEG or WebP, at most 512 KB), checks the
   * file's signature bytes and uploads it. `null` means the broker cancelled the picker.
   */
  uploadLogo(lenderId: string): Promise<ApiResult<LenderDto | null>>;
  removeLogo(lenderId: string): Promise<ApiResult<null>>;
  listSignatures(): Promise<ApiResult<readonly FeeSignatureDto[]>>;
  /** Copy-on-write: presets are never edited; a copy becomes the broker's own. */
  copySignature(
    sourceId: string,
    name?: string,
  ): Promise<ApiResult<FeeSignatureDto>>;
  updateSignature(
    signatureId: string,
    definition: FeeSignatureEditDto,
  ): Promise<ApiResult<FeeSignatureDto>>;
  removeSignature(signatureId: string): Promise<ApiResult<null>>;
}

/** A deliberately small renderer capability surface; no generic IPC method escapes Preload. */
export interface DesktopBridge {
  readonly auth: DesktopAuthBridge;
  readonly deals: DesktopDealsBridge;
  readonly quotes: DesktopQuotesBridge;
  readonly lenders: DesktopLendersBridge;
}

export * from './http.js';
