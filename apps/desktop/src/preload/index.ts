import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AuthStateDto,
  DesktopAuthBridge,
  DesktopBridge,
  DesktopDealsBridge,
  DesktopLendersBridge,
  DesktopMenuBridge,
  DesktopQuotesBridge,
  DesktopUpdatesBridge,
  MenuCommand,
  UpdateStatus,
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

// Application menu commands (Main → Renderer only). The names are duplicated from
// `menuCommands` in @swyft/contracts for the same reason as the channel names above;
// anything else arriving on the channel is dropped.
const menuCommandChannel = 'menu:command:v1';
const knownMenuCommands: readonly MenuCommand[] = [
  'new-deal',
  'show-calculator',
  'show-lenders',
  'toggle-deal-list',
];

const menu: DesktopMenuBridge = Object.freeze({
  onCommand(listener: (command: MenuCommand) => void): () => void {
    const handler = (_event: IpcRendererEvent, command: unknown) => {
      if (knownMenuCommands.includes(command as MenuCommand))
        listener(command as MenuCommand);
    };
    ipcRenderer.on(menuCommandChannel, handler);
    return () => {
      ipcRenderer.removeListener(menuCommandChannel, handler);
    };
  },
});

// Automatic updates. The status is rebuilt from known fields only, so nothing else Main
// might attach reaches the Renderer.
const updateStatusChannel = 'updates:status:v1';
const toUpdateStatus = (value: unknown): UpdateStatus => {
  const status = value as { state?: unknown; version?: unknown } | null;
  return status?.state === 'ready' &&
    typeof status.version === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(status.version)
    ? { state: 'ready', version: status.version }
    : { state: 'none' };
};

const updates: DesktopUpdatesBridge = Object.freeze({
  getStatus: async () =>
    toUpdateStatus(await invoke<unknown>('updates:get-status:v1')),
  install: () => invoke<void>('updates:install:v1'),
  onStatus(listener: (status: UpdateStatus) => void): () => void {
    const handler = (_event: IpcRendererEvent, status: unknown) =>
      listener(toUpdateStatus(status));
    ipcRenderer.on(updateStatusChannel, handler);
    return () => {
      ipcRenderer.removeListener(updateStatusChannel, handler);
    };
  },
});

const bridge: DesktopBridge = Object.freeze({
  auth,
  deals: Object.freeze(deals),
  quotes: Object.freeze(quotes),
  lenders: Object.freeze(lenders),
  menu,
  updates,
});

// Renderer receives only named capabilities, never ipcRenderer or a generic channel sender.
contextBridge.exposeInMainWorld('swyft', bridge);
