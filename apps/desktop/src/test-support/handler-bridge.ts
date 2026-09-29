import type {
  AuthStateDto,
  DesktopAuthBridge,
  DesktopBridge,
} from '@swyft/contracts';
import { businessChannels as c } from '../main/ipc/business-handlers';

type Handlers = Readonly<Record<string, (args: readonly unknown[]) => unknown>>;

/**
 * The Preload bridge without Electron's IPC transport: each method calls the real Main
 * handler for its channel with the same positional arguments Preload sends, so the
 * Renderer runs against real validation, the real API client and a real API. Only the
 * transport (ipcRenderer.invoke) is replaced, because Electron cannot run under jsdom.
 */
export function bridgeFromHandlers(
  handlers: Handlers,
  auth: DesktopAuthBridge,
): DesktopBridge {
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`No Main handler for ${channel}`);
    // Structured-clone the arguments as IPC does, so no object identity leaks across.
    return Promise.resolve(handler(structuredClone(args))) as Promise<T>;
  };
  return {
    auth,
    deals: {
      list: (cursor) => invoke(c.dealsList, cursor),
      create: (name) => invoke(c.dealsCreate, name),
      rename: (id, name) => invoke(c.dealsRename, id, name),
      remove: (id) => invoke(c.dealsRemove, id),
    },
    quotes: {
      list: (dealId) => invoke(c.quotesList, dealId),
      save: (dealId, key, request) =>
        invoke(c.quotesSave, dealId, key, request),
      updateNotes: (id, notes) => invoke(c.quotesUpdateNotes, id, notes),
      remove: (id) => invoke(c.quotesRemove, id),
      clear: (dealId) => invoke(c.quotesClear, dealId),
      preview: (request) => invoke(c.quotesPreview, request),
      targetCommission: (request) => invoke(c.quotesTargetCommission, request),
      copyExport: (request) => invoke(c.quotesCopyExport, request),
    },
    lenders: {
      listLenders: () => invoke(c.lendersList),
      createLender: (input) => invoke(c.lendersCreate, input),
      updateLender: (id, patch) => invoke(c.lendersUpdate, id, patch),
      removeLender: (id) => invoke(c.lendersRemove, id),
      logo: (id) => invoke(c.lendersLogo, id),
      uploadLogo: (id) => invoke(c.lendersUploadLogo, id),
      removeLogo: (id) => invoke(c.lendersRemoveLogo, id),
      listSignatures: () => invoke(c.signaturesList),
      copySignature: (id, name) => invoke(c.signaturesCopy, id, name),
      updateSignature: (id, definition) =>
        invoke(c.signaturesUpdate, id, definition),
      removeSignature: (id) => invoke(c.signaturesRemove, id),
    },
  };
}

/** Relays AuthSessionManager state changes to Renderer listeners, as Main's IPC event does. */
export class AuthStateRelay {
  private readonly listeners = new Set<(state: AuthStateDto) => void>();

  publish = (state: AuthStateDto): void => {
    for (const listener of this.listeners) listener(state);
  };

  subscribe(listener: (state: AuthStateDto) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
