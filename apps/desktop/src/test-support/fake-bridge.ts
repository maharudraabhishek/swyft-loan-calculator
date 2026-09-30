import type {
  ApiFailure,
  LenderDto,
  ApiResult,
  AuthStateDto,
  DealDto,
  DesktopBridge,
  FeeSignatureDto,
  MenuCommand,
  QuoteCreateDto,
  QuoteDto,
  QuoteExportRequestDto,
  UpdateStatus,
} from '@swyft/contracts';
import { vi } from 'vitest';
import { previewQuote, targetCommission } from '../main/quote-preview';
import { dealFixture, signatureFixtures } from './fixtures';

/**
 * An in-memory stand-in for Main + Cloud Run used by renderer workflow tests. Saving
 * "recalculates" with the real shared engine (like the API) and returns a new server
 * record; `failNext` injects a failure for the next call of one operation.
 */
export function createFakeBridge(
  options: {
    deals?: DealDto[];
    signatures?: FeeSignatureDto[];
    quotes?: QuoteDto[];
    lenders?: LenderDto[];
  } = {},
) {
  const store = {
    deals: options.deals ?? [dealFixture()],
    quotes: options.quotes ?? [],
    signatures: options.signatures ?? Object.values(signatureFixtures),
    lenders: options.lenders ?? ([] as LenderDto[]),
  };
  /** Bytes the fake "file picker" returns; a real PNG signature so the UI shows an image. */
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const failures = new Map<string, ApiFailure>();
  let sequence = 0;
  const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
  const run = async <T>(
    operation: string,
    action: () => T,
  ): Promise<ApiResult<T>> => {
    await Promise.resolve();
    const failure = failures.get(operation);
    if (failure) {
      failures.delete(operation);
      return { ok: false, error: failure };
    }
    return ok(action());
  };
  const nextId = (prefix: string) =>
    `${prefix}1111111-1111-4111-8111-${String(++sequence).padStart(12, '0')}`;

  const saveKeys: string[] = [];
  const menuListeners = new Set<(command: MenuCommand) => void>();
  const updateListeners = new Set<(status: UpdateStatus) => void>();
  let updateStatus: UpdateStatus = { state: 'none' };
  const exports: QuoteExportRequestDto[] = [];

  function serverQuote(dealId: string, request: QuoteCreateDto): QuoteDto {
    const signature = store.signatures.find(
      (item) => item.id === request.feeSignatureId,
    );
    if (!signature) throw new Error('unknown signature');
    const response = previewQuote({ signature, request });
    if (!response.ok) throw new Error(response.message);
    const { schedule, ...figures } = response.preview;
    if (schedule.length === 0)
      throw new Error('The engine returned no schedule');
    const deal = store.deals.find((item) => item.id === dealId);
    return {
      id: nextId('9'),
      dealId,
      quoteLogId: deal?.quoteLogId ?? dealId,
      feeSignatureId: signature.id,
      lenderName: signature.lenderName,
      feeSignatureName: signature.name,
      feeSignatureVersion: signature.version,
      commissionModel: signature.commissionModel,
      interestMethod: signature.interestMethod,
      paymentTiming: signature.paymentTiming,
      assetDescription: request.assetDescription ?? '',
      financeAmount: request.financeAmount,
      termMonths: request.termMonths,
      balloon: request.balloon ?? '0',
      baseRate: request.baseRate,
      ...figures,
      engineVersion: 'finance-1.0.0',
      notes: request.notes ?? '',
      createdAt: '2026-09-29T05:00:00.000Z',
      updatedAt: '2026-09-29T05:00:00.000Z',
    };
  }

  let authListener: ((state: AuthStateDto) => void) | undefined;
  const bridge = {
    auth: {
      getState: vi.fn(async (): Promise<AuthStateDto> => ({
        status: 'signed-in',
        user: { email: 'broker@example.test', displayName: 'Broker' },
        remembersSession: true,
      })),
      signIn: vi.fn(async () => undefined),
      signOut: vi.fn(async () => {
        authListener?.({ status: 'signed-out', remembersSession: true });
      }),
      retry: vi.fn(async () => undefined),
      onStateChanged: vi.fn((listener: (state: AuthStateDto) => void) => {
        authListener = listener;
        return () => {
          authListener = undefined;
        };
      }),
    },
    deals: {
      list: vi.fn(() =>
        run('deals.list', () => ({
          items: [...store.deals],
          nextCursor: null,
        })),
      ),
      create: vi.fn((name: string) =>
        run('deals.create', () => {
          const deal = dealFixture({
            id: nextId('2'),
            quoteLogId: nextId('3'),
            name: name.trim(),
          });
          store.deals = [deal, ...store.deals];
          return deal;
        }),
      ),
      rename: vi.fn((id: string, name: string) =>
        run('deals.rename', () => {
          const deal = {
            ...store.deals.find((item) => item.id === id)!,
            name: name.trim(),
          };
          store.deals = store.deals.map((item) =>
            item.id === id ? deal : item,
          );
          return deal;
        }),
      ),
      remove: vi.fn((id: string) =>
        run('deals.remove', () => {
          store.deals = store.deals.filter((item) => item.id !== id);
          store.quotes = store.quotes.filter((quote) => quote.dealId !== id);
          return null;
        }),
      ),
    },
    quotes: {
      list: vi.fn((dealId: string) =>
        run('quotes.list', () =>
          store.quotes.filter((quote) => quote.dealId === dealId),
        ),
      ),
      save: vi.fn((dealId: string, key: string, request: QuoteCreateDto) => {
        saveKeys.push(key);
        return run('quotes.save', () => {
          const quote = serverQuote(dealId, request);
          store.quotes = [...store.quotes, quote];
          return quote;
        });
      }),
      updateNotes: vi.fn((id: string, notes: string) =>
        run('quotes.updateNotes', () => {
          const quote = {
            ...store.quotes.find((item) => item.id === id)!,
            notes,
          };
          store.quotes = store.quotes.map((item) =>
            item.id === id ? quote : item,
          );
          return quote;
        }),
      ),
      remove: vi.fn((id: string) =>
        run('quotes.remove', () => {
          store.quotes = store.quotes.filter((item) => item.id !== id);
          return null;
        }),
      ),
      clear: vi.fn((dealId: string) =>
        run('quotes.clear', () => {
          const before = store.quotes.length;
          store.quotes = store.quotes.filter(
            (quote) => quote.dealId !== dealId,
          );
          return { deleted: before - store.quotes.length };
        }),
      ),
      preview: vi.fn(async (request: unknown) => previewQuote(request)),
      targetCommission: vi.fn(async (request: unknown) =>
        targetCommission(request),
      ),
      copyExport: vi.fn((request: QuoteExportRequestDto) => {
        exports.push(request);
        return run('quotes.copyExport', () => ({
          quoteCount: request.quotes.length,
        }));
      }),
    },
    lenders: {
      listLenders: vi.fn(() => run('lenders.list', () => [...store.lenders])),
      createLender: vi.fn(
        (input: { name: string; websiteUrl: string | null }) =>
          run('lenders.create', () => {
            const lender: LenderDto = {
              id: nextId('4'),
              name: input.name.trim(),
              websiteUrl: input.websiteUrl,
              isPreset: false,
              hasLogo: false,
              logoUpdatedAt: null,
              createdAt: '2026-09-29T05:00:00.000Z',
              updatedAt: '2026-09-29T05:00:00.000Z',
            };
            store.lenders = [...store.lenders, lender];
            return lender;
          }),
      ),
      updateLender: vi.fn(
        (id: string, patch: { name?: string; websiteUrl?: string | null }) =>
          run('lenders.update', () => {
            const lender = {
              ...store.lenders.find((item) => item.id === id)!,
              ...patch,
            };
            store.lenders = store.lenders.map((item) =>
              item.id === id ? lender : item,
            );
            return lender;
          }),
      ),
      removeLender: vi.fn((id: string) =>
        run('lenders.remove', () => {
          store.lenders = store.lenders.filter((item) => item.id !== id);
          store.signatures = store.signatures.filter(
            (item) => item.lenderId !== id,
          );
          return null;
        }),
      ),
      logo: vi.fn(() => run('lenders.logo', () => ({ dataUrl: pngDataUrl }))),
      uploadLogo: vi.fn((id: string) =>
        run('lenders.uploadLogo', () => {
          const lender = {
            ...store.lenders.find((item) => item.id === id)!,
            hasLogo: true,
            logoUpdatedAt: '2026-09-29T06:00:00.000Z',
          };
          store.lenders = store.lenders.map((item) =>
            item.id === id ? lender : item,
          );
          return lender;
        }),
      ),
      removeLogo: vi.fn((id: string) =>
        run('lenders.removeLogo', () => {
          store.lenders = store.lenders.map((item) =>
            item.id === id
              ? { ...item, hasLogo: false, logoUpdatedAt: null }
              : item,
          );
          return null;
        }),
      ),
      listSignatures: vi.fn(() =>
        run('signatures.list', () => [...store.signatures]),
      ),
      copySignature: vi.fn((id: string, name?: string) =>
        run('signatures.copy', () => {
          const source = store.signatures.find((item) => item.id === id)!;
          const copy = {
            ...source,
            id: nextId('7'),
            isPreset: false,
            sourceFeeSignatureId: id,
            name: name ?? source.name,
          };
          store.signatures = [...store.signatures, copy];
          return copy;
        }),
      ),
      updateSignature: vi.fn((id: string) =>
        run('signatures.update', () =>
          store.signatures.find((item) => item.id === id)!,
        ),
      ),
      removeSignature: vi.fn((id: string) =>
        run('signatures.remove', () => {
          store.signatures = store.signatures.filter((item) => item.id !== id);
          return null;
        }),
      ),
    },
    menu: {
      onCommand: vi.fn((listener: (command: MenuCommand) => void) => {
        menuListeners.add(listener);
        return () => {
          menuListeners.delete(listener);
        };
      }),
    },
    updates: {
      getStatus: vi.fn(async () => updateStatus),
      install: vi.fn(async () => undefined),
      onStatus: vi.fn((listener: (status: UpdateStatus) => void) => {
        updateListeners.add(listener);
        return () => {
          updateListeners.delete(listener);
        };
      }),
    },
  } satisfies DesktopBridge;

  return {
    bridge,
    store,
    saveKeys,
    exports,
    failNext(operation: string, failure: ApiFailure) {
      failures.set(operation, failure);
    },
    /** Fires an application-menu command, as Main does on a menu click or shortcut. */
    sendMenuCommand(command: MenuCommand) {
      for (const listener of menuListeners) listener(command);
    },
    /** Reports a downloaded update, as Main does when electron-updater finishes. */
    updateReady(version: string) {
      updateStatus = { state: 'ready', version };
      for (const listener of updateListeners) listener(updateStatus);
    },
  };
}
