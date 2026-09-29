import {
  quotePreviewRequestSchema,
  targetCommissionRequestSchema,
  type QuotePreviewResponseDto,
  type TargetCommissionResponseDto,
} from '@swyft/contracts';
import { Money } from '@swyft/finance';
import {
  QuoteCompositionError,
  calculateFromSignature,
  solveTargetCommission,
  feeSignatureFromDto,
  quoteRequestFromDto,
  scheduleFor,
  summarizeCalculation,
} from '@swyft/quoting';
import type { z } from 'zod';

/**
 * Engine range errors with a known cause, rephrased for the field a broker can fix.
 * Everything else becomes one generic message; raw exception text never crosses IPC.
 */
const knownRangeErrors: ReadonlyArray<readonly [RegExp, string, string]> = [
  [
    /First repayment precedes settlement|Repayment dates must increase/,
    'firstRepaymentDate',
    'The first repayment must be after the settlement date.',
  ],
  [
    /NSW holiday policy/,
    'settlementDate',
    'Dates must fall within 2025–2032 (the supported NSW holiday calendar).',
  ],
  [/Invalid balloon/, 'balloon', 'The balloon is too large for this loan.'],
  [
    /Contract rate cannot be below base rate/,
    'contractRate',
    'The contract rate cannot be below the base rate.',
  ],
  // Very short terms spread capitalised commission and fees over too few payments: the
  // payment exists, but the comparison rate that explains it would exceed 100% p.a.
  [
    /annual rate above the supported 100% bound/,
    'termMonths',
    'This term is too short: the comparison rate would exceed 100% p.a. Use a longer term.',
  ],
];

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    // Request issues are keyed by request field; signature issues mean stale data.
    const [scope, field] = issue.path;
    const key =
      scope === 'request' && typeof field === 'string'
        ? field
        : scope === 'targetCommission'
          ? 'targetCommission'
          : 'signature';
    fields[key] ??= issue.message;
  }
  return fields;
}

/**
 * Local, never-saved quote preview. Uses the same validation schema, transport mapping,
 * composition and engine as server recalculation, so a successful preview is what the
 * API will store for the same signature version and inputs.
 */
export function previewQuote(value: unknown): QuotePreviewResponseDto {
  const parsed = quotePreviewRequestSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      message: 'Check the highlighted fields.',
      fields: zodFields(parsed.error),
    };
  try {
    const calculated = calculateFromSignature(
      feeSignatureFromDto(parsed.data.signature),
      quoteRequestFromDto(parsed.data.request),
    );
    return {
      ok: true,
      preview: {
        ...summarizeCalculation(calculated),
        schedule: scheduleFor(
          calculated,
          parsed.data.signature.interestMethod === 'monthly'
            ? parsed.data.scheduleStartDate
            : undefined,
        ),
      },
    };
  } catch (error) {
    return explainFailure(error);
  }
}

interface Failure {
  readonly ok: false;
  readonly message: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Composition rules, known engine range errors, else a generic message. */
function explainFailure(error: unknown): Failure {
  if (error instanceof QuoteCompositionError)
    return {
      ok: false,
      message: error.message,
      fields: { [error.field]: error.message },
    };
  if (error instanceof RangeError || error instanceof TypeError) {
    for (const [pattern, field, message] of knownRangeErrors)
      if (pattern.test(error.message))
        return { ok: false, message, fields: { [field]: message } };
    return {
      ok: false,
      message: 'These values are outside the range this lender supports.',
      fields: {},
    };
  }
  return {
    ok: false,
    message: 'The quote could not be calculated. Check the inputs.',
    fields: {},
  };
}

/**
 * Target commission calculator: the rate that earns a target commission for the current
 * inputs, solved locally with the same composition and engine as a saved quote.
 */
export function targetCommission(value: unknown): TargetCommissionResponseDto {
  const parsed = targetCommissionRequestSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      message: 'Check the highlighted fields.',
      fields: zodFields(parsed.error),
    };
  try {
    const solution = solveTargetCommission(
      feeSignatureFromDto(parsed.data.signature),
      quoteRequestFromDto(parsed.data.request),
      Money.from(parsed.data.targetCommission),
    );
    return solution.kind === 'contract-rate'
      ? {
          ok: true,
          solves: 'contractRate',
          rate: solution.contractRate.toString(),
          commission: solution.commission.toFixed(2),
          contractRate: solution.contractRate.toString(),
          metByBaseCommission: solution.metByBaseCommission,
        }
      : {
          ok: true,
          solves: 'commissionRate',
          rate: solution.commissionRate.toString(),
          commission: solution.commission.toFixed(2),
          contractRate:
            solution.contractRate?.decimal().toDecimalPlaces(10).toString() ??
            null,
          metByBaseCommission: false,
        };
  } catch (error) {
    return explainFailure(error);
  }
}
