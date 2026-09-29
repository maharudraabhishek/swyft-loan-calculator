import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const executable = path.join(
  desktopRoot,
  'dist',
  'win-unpacked',
  'Swyft Finance.exe',
);
if (process.platform !== 'win32' || !existsSync(executable)) {
  throw new Error(`Packaged Windows executable is unavailable: ${executable}`);
}

const port = 19337;
const child = spawn(
  executable,
  [`--remote-debugging-port=${port}`, '--no-first-run'],
  {
    windowsHide: true,
    stdio: 'ignore',
  },
);

async function target() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Packaged app exited: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const renderer = targets.find(
          (item) =>
            item.type === 'page' && item.url === 'app://swyft/index.html',
        );
        if (renderer?.webSocketDebuggerUrl)
          return renderer.webSocketDebuggerUrl;
      }
    } catch {
      // Electron may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Packaged renderer did not load within 30 seconds');
}

async function evaluate(socketUrl, expression) {
  const socket = new WebSocket(socketUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Packaged preview timed out')),
        10_000,
      );
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails)
          reject(
            new Error(
              `Renderer evaluation failed: ${JSON.stringify(message.error ?? message.result.exceptionDetails)}`,
            ),
          );
        else resolve(message.result.result.value);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  } finally {
    socket.close();
  }
}

try {
  const socketUrl = await target();
  // Zero-rate signatures make every model's figures exact and hand-checkable:
  // (1200 - 240 balloon) / 12 = 80.00; hiring = 80 × 12 + 240 + $50 upfront fee = 1250.00.
  const base = {
    lenderId: '00000000-0000-4000-8000-000000000001',
    lenderName: 'Smoke',
    isPreset: false,
    sourceFeeSignatureId: null,
    interestMethod: 'monthly',
    paymentTiming: 'arrears',
    defaultCommissionRate: '0',
    maxCommissionRate: null,
    baseCommission: null,
    oversShare: null,
    gstRate: null,
    loadingFactor: null,
    rateMarkupFactor: null,
    monthlyFee: '0',
    slidingFee: '0',
    maxBrokerOrigination: null,
    fees: { establishment: { amount: '50', financed: false } },
    version: 1,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
  const id = (n) => `00000000-0000-4000-8000-00000000090${n}`;
  const signatures = [
    { ...base, id: id(1), name: 'C', commissionModel: 'capitalised' },
    {
      ...base,
      id: id(2),
      name: 'O',
      commissionModel: 'overs',
      defaultCommissionRate: null,
      baseCommission: '110',
      oversShare: '0.75',
      gstRate: '0.1',
    },
    {
      ...base,
      id: id(3),
      name: 'L',
      commissionModel: 'loaded',
      loadingFactor: '0.4',
    },
    {
      ...base,
      id: id(4),
      name: 'D',
      commissionModel: 'daily_interest',
      interestMethod: 'daily',
      rateMarkupFactor: '0.4',
      monthlyFee: '12.50',
      slidingFee: '12.50',
    },
  ];
  const requests = signatures.map((signature) => ({
    signature,
    request: {
      feeSignatureId: signature.id,
      financeAmount: '1200',
      termMonths: 12,
      baseRate: '0',
      balloon: '240',
      ...(signature.commissionModel === 'overs' ? { contractRate: '0' } : {}),
      ...(signature.commissionModel === 'daily_interest'
        ? { settlementDate: '2025-06-01', firstRepaymentDate: '2025-07-01' }
        : {}),
    },
  }));
  const result = await evaluate(
    socketUrl,
    `(async () => {
      const deadline = Date.now() + 7500;
      while (document.readyState !== 'complete' || typeof window.swyft?.quotes?.preview !== 'function') {
        if (Date.now() >= deadline) throw new Error('Packaged preload bridge did not become ready');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const responses = await Promise.all(${JSON.stringify(requests)}.map(request => window.swyft.quotes.preview(request)));
      let auth = await window.swyft.auth.getState();
      while (auth.status === 'restoring' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        auth = await window.swyft.auth.getState();
      }
      // Wait for React to render the screen for the settled state (no fixed sleep).
      while (!document.body.textContent.includes('Sign in with Google') && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 50));
      const text = document.body.textContent;
      return {
        signInOnly: text.includes('Sign in with Google') && !text.includes('New deal') && !text.includes('Sign out'),
        auth,
        bridgeKeys: Object.keys(window.swyft).sort(),
        authKeys: Object.keys(window.swyft.auth).sort(),
        dealsWhileSignedOut: await window.swyft.deals.list(),
        forgedId: await window.swyft.quotes.remove('../../v1/deals'),
        responses,
      };
    })()`,
  );
  const bad = (response) =>
    !response.ok ||
    response.preview.monthlyPayment !== '80.00' ||
    response.preview.amountFinanced !== '1200.00' ||
    response.preview.totalHiring !== '1250.00';
  if (
    !result?.signInOnly ||
    result.auth?.status !== 'signed-out' ||
    /sw[abrc]_/.test(JSON.stringify(result.auth)) ||
    JSON.stringify(result.bridgeKeys) !==
      '["auth","deals","lenders","quotes"]' ||
    JSON.stringify(result.authKeys) !==
      '["getState","onStateChanged","retry","signIn","signOut"]' ||
    result.dealsWhileSignedOut?.error?.kind !== 'unauthenticated' ||
    result.forgedId?.error?.kind !== 'invalid-request' ||
    result.responses?.length !== 4 ||
    result.responses.some(bad) ||
    result.responses[3].preview.grossMonthlyPayment !== '92.50' ||
    result.responses[3].preview.schedule[0].feesDollars !== '25.00' ||
    result.responses[3].preview.schedule[1].feesDollars !== '12.50'
  ) {
    throw new Error(
      `Packaged renderer or quote bridge failed smoke test: ${JSON.stringify(result)}`,
    );
  }
  process.stdout.write(
    'Packaged renderer (signed-out: sign-in screen only), narrow bridge (auth/deals/quotes/lenders), signed-out API refusal, IPC argument validation, all four models via signature preview, hiring totals and first-only Autopay fee passed.\n',
  );
} finally {
  child.kill();
}
