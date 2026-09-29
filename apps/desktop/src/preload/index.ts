import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AuthStateDto,
  DesktopAuthBridge,
  DesktopBridge,
  DesktopDealsBridge,
  DesktopLendersBridge,
  DesktopQuotesBridge,
} from '@swyft/contracts';

const authStateChannel = 'auth:state-changed:v1';

// Channel names are duplicated from Main on purpose: Preload is sandboxed and must not
// import Main modules. Main validates every argument; Preload only forwards them.
const invoke = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const auth: DesktopAuthBridge = Object.freeze({
  getState: () => invoke<AuthStateDto>('auth:get-state:v1'),
  signIn: () => invoke<void>('auth:sign-in:v1'),
  signOut: () => invoke<void>('auth:sign-out:v1'),
  retry: () => invoke<void>('auth:retry:v1'),
  onStateChanged(listener: (state: AuthStateDto) => void): () => void {
    // The IPC event object is never handed to the Renderer.
    const handler = (_event: IpcRendererEvent, state: AuthStateDto) =>
      listener(state);
    ipcRenderer.on(authStateChannel, handler);
    return () => {
      ipcRenderer.removeListener(authStateChannel, handler);
    };
  },
});

const deals: DesktopDealsBridge = {
  list: (cursor) => invoke('deals:list:v1', cursor),
  create: (name) => invoke('deals:create:v1', name),
  rename: (dealId, name) => invoke('deals:rename:v1', dealId, name),
  remove: (dealId) => invoke('deals:remove:v1', dealId),
};

const quotes: DesktopQuotesBridge = {
  list: (dealId) => invoke('quotes:list:v1', dealId),
  save: (dealId, idempotencyKey, request) =>
    invoke('quotes:save:v1', dealId, idempotencyKey, request),
  updateNotes: (quoteId, notes) =>
    invoke('quotes:update-notes:v1', quoteId, notes),
  remove: (quoteId) => invoke('quotes:remove:v1', quoteId),
  clear: (dealId) => invoke('quotes:clear:v1', dealId),
  preview: (request) => invoke('quotes:preview:v2', request),
  targetCommission: (request) => invoke('quotes:target-commission:v1', request),
  copyExport: (request) => invoke('quotes:copy-export:v1', request),
};

const lenders: DesktopLendersBridge = {
  listLenders: () => invoke('lenders:list:v1'),
  createLender: (input) => invoke('lenders:create:v1', input),
  updateLender: (lenderId, patch) =>
    invoke('lenders:update:v1', lenderId, patch),
  removeLender: (lenderId) => invoke('lenders:remove:v1', lenderId),
  logo: (lenderId) => invoke('lenders:logo:v1', lenderId),
  uploadLogo: (lenderId) => invoke('lenders:upload-logo:v1', lenderId),
  removeLogo: (lenderId) => invoke('lenders:remove-logo:v1', lenderId),
  listSignatures: () => invoke('fee-signatures:list:v1'),
  copySignature: (sourceId, name) =>
    invoke('fee-signatures:copy:v1', sourceId, name),
  updateSignature: (signatureId, definition) =>
    invoke('fee-signatures:update:v1', signatureId, definition),
  removeSignature: (signatureId) =>
    invoke('fee-signatures:remove:v1', signatureId),
};

const bridge: DesktopBridge = Object.freeze({
  auth,
  deals: Object.freeze(deals),
  quotes: Object.freeze(quotes),
  lenders: Object.freeze(lenders),
});

// Renderer receives only named capabilities, never ipcRenderer or a generic channel sender.
contextBridge.exposeInMainWorld('swyft', bridge);
