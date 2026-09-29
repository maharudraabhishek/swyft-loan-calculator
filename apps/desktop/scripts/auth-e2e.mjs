// Real sign-in lifecycle check for the packaged Windows app against the deployed API.
//
//   node scripts/auth-e2e.mjs signin    click "Sign in with Google"; you finish in your browser
//   node scripts/auth-e2e.mjs restart   relaunch; the remembered session must restore silently
//   node scripts/auth-e2e.mjs signout   click "Sign out"; state and session.bin must be cleared
//   node scripts/auth-e2e.mjs status    report the current state
//
// It reads only the Renderer's AuthStateDto (no tokens exist there) and whether the
// safeStorage file exists. It never reads or prints the file's contents.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'status';
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
const sessionFile = path.join(
  process.env.APPDATA ?? '',
  'Swyft Finance',
  'session.bin',
);
if (process.platform !== 'win32' || !existsSync(executable))
  throw new Error(`Packaged Windows executable is unavailable: ${executable}`);

const port = 19338;
const child = spawn(
  executable,
  [`--remote-debugging-port=${port}`, '--no-first-run'],
  {
    stdio: 'ignore',
  },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rendererSocket() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`App exited: ${child.exitCode}`);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const page = targets.find(
        (item) => item.type === 'page' && item.url === 'app://swyft/index.html',
      );
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error('Renderer did not load');
}

let nextId = 1;
async function evaluate(socket, expression) {
  const id = nextId++;
  const reply = new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (message.result?.exceptionDetails)
        reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    };
    socket.addEventListener('message', onMessage);
  });
  socket.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
  return reply;
}

const state = (socket) =>
  evaluate(
    socket,
    `(async () => {
      const auth = await window.swyft.auth.getState();
      const text = document.body.textContent;
      return { status: auth.status, email: auth.user?.email ?? null, message: auth.message ?? null,
        remembersSession: auth.remembersSession,
        signInScreenOnly: text.includes('Sign in with Google') && !text.includes('New deal'),
        appVisible: text.includes('New deal') && text.includes('Sign out'),
        tokenLike: /sw[abrc]_[A-Za-z0-9_-]{20,}/.test(JSON.stringify(auth) + text) };
    })()`,
  );

async function waitFor(socket, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current = await state(socket);
  while (!predicate(current) && Date.now() < deadline) {
    await sleep(500);
    current = await state(socket);
  }
  return current;
}

const clickButton = (socket, label) =>
  evaluate(
    socket,
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(label)}));
      if (!b) return false; b.click(); return true; })()`,
  );

try {
  const socket = new WebSocket(await rendererSocket());
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  // The page can load before Preload has exposed the bridge; wait for it.
  const bridgeDeadline = Date.now() + 15_000;
  while (
    !(await evaluate(
      socket,
      "document.readyState === 'complete' && typeof window.swyft?.auth?.getState === 'function'",
    ))
  ) {
    if (Date.now() > bridgeDeadline)
      throw new Error('Preload bridge not ready');
    await sleep(100);
  }
  // Settled = auth state final AND the matching screen rendered (no timing guesses).
  const settled = (s) =>
    (s.status === 'signed-out' && s.signInScreenOnly) ||
    (s.status === 'signed-in' && s.appVisible) ||
    s.status === 'offline';
  let result = await waitFor(socket, settled, 20_000);
  const report = { mode, initial: result };

  if (mode === 'signin') {
    if (result.status !== 'signed-out')
      throw new Error(`Expected signed-out, got ${result.status}`);
    report.clicked = await clickButton(socket, 'Sign in with Google');
    process.stdout.write(
      'Browser opened: complete Google sign-in there (5 minutes)...\n',
    );
    result = await waitFor(
      socket,
      (s) =>
        s.status === 'signed-in' || (s.status === 'signed-out' && s.message),
      300_000,
    );
  } else if (mode === 'signout') {
    if (result.status !== 'signed-in')
      throw new Error(`Expected signed-in, got ${result.status}`);
    report.clicked = await clickButton(socket, 'Sign out');
    result = await waitFor(socket, (s) => s.status === 'signed-out', 15_000);
    await sleep(1_000);
  }
  report.final = result;
  report.sessionFileExists = existsSync(sessionFile);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  socket.close();
} finally {
  child.kill();
}
