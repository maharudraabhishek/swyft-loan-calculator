import {
  dealWriteSchema,
  feeSignatureCopySchema,
  feeSignatureDefinitionSchema,
  lenderCreateSchema,
  lenderUpdateSchema,
  quoteCreateSchema,
  quoteExportRequestSchema,
  quoteUpdateSchema,
  uuidSchema,
  type ApiResult,
} from '@swyft/contracts';
import { z } from 'zod';
import { buildQuoteExport } from '../../shared/quote-export';
import {
  ApiRequestError,
  toApiResult,
  type BusinessApiClient,
} from '../api/business-api';
import { previewQuote, targetCommission } from '../quote-preview';

/** IPC channel names; versioned so a future shape change gets a new channel. */
export const businessChannels = {
  dealsList: 'deals:list:v1',
  dealsCreate: 'deals:create:v1',
  dealsRename: 'deals:rename:v1',
  dealsRemove: 'deals:remove:v1',
  quotesList: 'quotes:list:v1',
  quotesSave: 'quotes:save:v1',
  quotesUpdateNotes: 'quotes:update-notes:v1',
  quotesRemove: 'quotes:remove:v1',
  quotesClear: 'quotes:clear:v1',
  quotesPreview: 'quotes:preview:v2',
  quotesTargetCommission: 'quotes:target-commission:v1',
  quotesCopyExport: 'quotes:copy-export:v1',
  lendersList: 'lenders:list:v1',
  lendersCreate: 'lenders:create:v1',
  lendersUpdate: 'lenders:update:v1',
  lendersRemove: 'lenders:remove:v1',
  lendersLogo: 'lenders:logo:v1',
  lendersUploadLogo: 'lenders:upload-logo:v1',
  lendersRemoveLogo: 'lenders:remove-logo:v1',
  signaturesList: 'fee-signatures:list:v1',
  signaturesCopy: 'fee-signatures:copy:v1',
  signaturesUpdate: 'fee-signatures:update:v1',
  signaturesRemove: 'fee-signatures:remove:v1',
} as const;

/** Writes both clipboard formats in one atomic write (Electron `clipboard.write`). */
export type ClipboardWriter = (content: {
  readonly html: string;
  readonly text: string;
}) => Promise<void>;

/** Lets the broker choose a logo file in Main (system dialog); `null` when cancelled. */
export type LogoFilePicker = () => Promise<Uint8Array | null>;

type Handler = (args: readonly unknown[]) => Promise<unknown> | unknown;

const cursorSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional();
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const dealNameSchema = dealWriteSchema.shape.name;

const invalidRequest: ApiResult<never> = {
  ok: false,
  error: {
    kind: 'invalid-request',
    message: 'The request was not valid. Reload and try again.',
  },
};

/**
 * Parses positional IPC arguments with zod before anything reaches the API. The Renderer
 * is untrusted: IDs must be UUIDs, bodies must match the strict shared schemas, and extra
 * arguments are rejected.
 */
function withArgs<const S extends readonly z.ZodType[]>(
  schemas: S,
  run: (...values: { [K in keyof S]: z.output<S[K]> }) => Promise<unknown>,
): Handler {
  return (args) => {
    if (args.length > schemas.length) return invalidRequest;
    const values: unknown[] = [];
    for (const [index, schema] of schemas.entries()) {
      const parsed = schema.safeParse(args[index]);
      if (!parsed.success) return invalidRequest;
      values.push(parsed.data);
    }
    return run(...(values as { [K in keyof S]: z.output<S[K]> }));
  };
}

/** All business capabilities, keyed by channel. Trust checks happen at registration. */
export function createBusinessHandlers(
  api: BusinessApiClient,
  writeClipboard: ClipboardWriter,
  pickLogoFile: LogoFilePicker,
): Readonly<Record<string, Handler>> {
  const c = businessChannels;
  return {
    [c.dealsList]: withArgs([cursorSchema], (cursor) =>
      toApiResult(() => api.listDeals(cursor)),
    ),
    [c.dealsCreate]: withArgs([dealNameSchema], (name) =>
      toApiResult(() => api.createDeal(name)),
    ),
    [c.dealsRename]: withArgs([uuidSchema, dealNameSchema], (id, name) =>
      toApiResult(() => api.renameDeal(id, name)),
    ),
    [c.dealsRemove]: withArgs([uuidSchema], (id) =>
      toApiResult(() => api.deleteDeal(id)),
    ),
    [c.quotesList]: withArgs([uuidSchema], (dealId) =>
      toApiResult(() => api.listQuotes(dealId)),
    ),
    [c.quotesSave]: withArgs(
      [uuidSchema, idempotencyKeySchema, quoteCreateSchema],
      (dealId, key, request) =>
        toApiResult(() => api.saveQuote(dealId, key, request)),
    ),
    [c.quotesUpdateNotes]: withArgs(
      [uuidSchema, quoteUpdateSchema.shape.notes],
      (id, notes) => toApiResult(() => api.updateQuoteNotes(id, notes)),
    ),
    [c.quotesRemove]: withArgs([uuidSchema], (id) =>
      toApiResult(() => api.deleteQuote(id)),
    ),
    [c.quotesClear]: withArgs([uuidSchema], (dealId) =>
      toApiResult(() => api.clearQuotes(dealId)),
    ),
    [c.quotesPreview]: (args) =>
      args.length === 1
        ? previewQuote(args[0])
        : { ok: false, message: 'Invalid preview request.', fields: {} },
    [c.quotesTargetCommission]: (args) =>
      args.length === 1
        ? targetCommission(args[0])
        : { ok: false, message: 'Invalid request.', fields: {} },
    [c.quotesCopyExport]: withArgs([quoteExportRequestSchema], (request) =>
      toApiResult(async () => {
        // Final HTML is generated here from validated structured data, never supplied
        // by the Renderer, so the clipboard cannot be used as an arbitrary HTML sink.
        const { html, text } = buildQuoteExport(
          request.quotes,
          request.display,
        );
        try {
          await writeClipboard({ html, text });
        } catch {
          throw new ApiRequestError({
            kind: 'server',
            message: 'The system clipboard could not be written. Try again.',
          });
        }
        return { quoteCount: request.quotes.length };
      }),
    ),
    [c.lendersList]: withArgs([], () => toApiResult(() => api.listLenders())),
    [c.lendersCreate]: withArgs([lenderCreateSchema], (input) =>
      toApiResult(() => api.createLender(input)),
    ),
    [c.lendersUpdate]: withArgs([uuidSchema, lenderUpdateSchema], (id, patch) =>
      toApiResult(() => api.updateLender(id, patch)),
    ),
    [c.lendersRemove]: withArgs([uuidSchema], (id) =>
      toApiResult(() => api.deleteLender(id)),
    ),
    [c.lendersLogo]: withArgs([uuidSchema], (id) =>
      toApiResult(() => api.lenderLogo(id)),
    ),
    [c.lendersUploadLogo]: withArgs([uuidSchema], (id) =>
      toApiResult(async () => {
        const bytes = await pickLogoFile();
        return bytes === null ? null : api.putLenderLogo(id, bytes);
      }),
    ),
    [c.lendersRemoveLogo]: withArgs([uuidSchema], (id) =>
      toApiResult(() => api.deleteLenderLogo(id)),
    ),
    [c.signaturesList]: withArgs([], () =>
      toApiResult(() => api.listFeeSignatures()),
    ),
    [c.signaturesCopy]: withArgs(
      [uuidSchema, feeSignatureCopySchema.shape.name],
      (id, name) => toApiResult(() => api.copyFeeSignature(id, name)),
    ),
    [c.signaturesUpdate]: withArgs(
      [uuidSchema, feeSignatureDefinitionSchema],
      (id, definition) =>
        toApiResult(() => api.updateFeeSignature(id, definition)),
    ),
    [c.signaturesRemove]: withArgs([uuidSchema], (id) =>
      toApiResult(() => api.deleteFeeSignature(id)),
    ),
  };
}
