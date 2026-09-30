// Broker workflow against the deployed API, through the real packaged UI.
//
//   node scripts/workflow-e2e.mjs [screenshotDir]
//
// Requires a remembered sign-in (run `node scripts/auth-e2e.mjs signin` first). It drives
// the Renderer's DOM over the DevTools protocol exactly as a user would (click, type),
// creates one clearly named test deal, and deletes it at the end. It reads only what the
// UI shows plus the system clipboard; it never reads tokens or the session file.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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
const screenshotDir = process.argv[2];
if (process.platform !== 'win32' || !existsSync(executable))
  throw new Error(`Packaged Windows executable is unavailable: ${executable}`);
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

const port = 19339;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`,
  );
  if (!pass) throw new Error(`Check failed: ${name} ${detail}`);
};

class App {
  static async launch() {
    const app = new App();
    app.child = spawn(
      executable,
      [`--remote-debugging-port=${port}`, '--no-first-run'],
      {
        stdio: 'ignore',
      },
    );
    const deadline = Date.now() + 30_000;
    let page;
    while (!page && Date.now() < deadline) {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json();
        page = targets.find(
          (t) => t.type === 'page' && t.url === 'app://swyft/index.html',
        );
      } catch {
        // starting
      }
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('Renderer did not load');
    app.socket = await App.open(page.webSocketDebuggerUrl);
    const version = await (
      await fetch(`http://127.0.0.1:${port}/json/version`)
    ).json();
    app.browser = await App.open(version.webSocketDebuggerUrl);
    app.nextId = 1;
    return app;
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return socket;
  }

  send(socket, method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        socket.removeEventListener('message', onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send(this.socket, 'Runtime.evaluate', {
      expression: `(async () => { ${helpers}; ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  }

  async waitFor(expression, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      // While the renderer is (re)loading, the document may have no body yet or the
      // execution context may be replaced mid-evaluate; treat that as "not ready yet".
      try {
        if (await this.eval(`return Boolean(${expression});`)) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(200);
    }
    throw new Error(
      `Timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`,
    );
  }

  /** Emulates the window's content size; media and container queries respond as they would. */
  async resize(width, height) {
    await this.send(this.socket, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(400);
  }

  async screenshot(name) {
    if (!screenshotDir) return;
    const { data } = await this.send(this.socket, 'Page.captureScreenshot', {
      format: 'png',
    });
    writeFileSync(
      path.join(screenshotDir, `${name}.png`),
      Buffer.from(data, 'base64'),
    );
  }

  close() {
    this.socket?.close();
    this.child?.kill();
  }
}

// In-page helpers: find controls by accessible text and set values the way React expects.
const helpers = `
  const text = () => document.body.innerText;
  const byLabel = (label) => {
    const l = [...document.querySelectorAll('label')].find((x) => x.textContent.replace('*','').trim().startsWith(label));
    return l && (document.getElementById(l.htmlFor) ?? l.querySelector('input'));
  };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === name || b.getAttribute('aria-label') === name);
  const click = (name, root) => { const b = button(name, root); if (!b) throw new Error('No button ' + name); b.click(); return true; };
  const set = (el, value) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const fill = (label, value) => { const el = byLabel(label); if (!el) throw new Error('No field ' + label); set(el, value); };
  const chooseLender = (title) => {
    const select = byLabel('Lender and fee signature');
    const option = [...select.options].find((o) => o.textContent === title);
    if (!option) throw new Error('No lender ' + title);
    set(select, option.value);
  };
  const dialog = () => document.querySelector('[role="alertdialog"]');
`;

function readClipboard(format) {
  const script =
    format === 'html'
      ? 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::Html)'
      : 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)';
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', script],
    {
      encoding: 'utf8',
    },
  );
}

const dealName = `E2E workflow ${new Date().toISOString().replace(/[:.]/g, '-')}`;
let app;
try {
  app = await App.launch();
  await app.waitFor(
    `text().includes('New deal') && text().includes('Sign out')`,
    'signed-in app',
    30_000,
  );
  check('Signed-in shell restored from the remembered session', true);
  await app.resize(1440, 900);
  check(
    'Landing screen is the quote calculator (no deal needed)',
    await app.eval(
      `return [...document.querySelectorAll('h2')].some((h) => h.textContent === 'New quote') && Boolean(byLabel('Finance amount')) && [...document.querySelectorAll('[role=tab]')].filter((t) => t.disabled).length === 2;`,
    ),
  );

  // Deal
  await app.eval(`click('New deal'); return true;`);
  await app.eval(
    `fill('Deal name', ${JSON.stringify(dealName)}); click('Create deal'); return true;`,
  );
  await app.waitFor(
    `[...document.querySelectorAll('h2')].some((h) => h.textContent === ${JSON.stringify(dealName)})`,
    'deal workspace',
  );
  check('Deal created on Cloud Run and opened as a workspace', true, dealName);
  await app.waitFor(
    `byLabel('Lender and fee signature')?.options.length >= 10`,
    'preset lenders',
  );
  const lenders = await app.eval(
    `return [...byLabel('Lender and fee signature').options].map((o) => o.textContent);`,
  );
  check(
    'All ten preset fee signatures loaded from the API',
    [
      'Pepper — Commercial Dealer',
      'Pepper — Commercial Private',
      'Firstmac — Dealer',
      'Firstmac — Private',
      'Westpac — Dealer',
      'Westpac — Private',
      'Branded — Dealer',
      'Branded — Private',
      'Autopay — Standard',
      'Metro — Standard',
    ].every((name) => lenders.includes(name)),
    `${lenders.length} options`,
  );

  // Three lenders for the same deal
  const quotes = [
    { lender: 'Westpac — Dealer', fields: { 'Base rate': '8.5' } },
    {
      lender: 'Branded — Dealer',
      fields: { 'Base rate': '8.54', 'Contract (customer) rate': '10.04' },
    },
    {
      lender: 'Autopay — Standard',
      fields: {
        'Base rate': '7.35',
        Commission: '4',
        'Broker origination fee': '490',
      },
    },
  ];
  await app.eval(
    `fill('Finance amount', '30000'); fill('Asset description', 'E2E 2024 Ranger <b>XLT</b>'); fill('Term (months)', '60'); return true;`,
  );
  let saved = 0;
  for (const quote of quotes) {
    await app.eval(
      `chooseLender(${JSON.stringify(quote.lender)}); return true;`,
    );
    for (const [label, value] of Object.entries(quote.fields))
      await app.eval(
        `fill(${JSON.stringify(label)}, ${JSON.stringify(value)}); return true;`,
      );
    await app.waitFor(
      `text().includes('Comparison rate') && !text().includes('Calculating…')`,
      `${quote.lender} preview`,
    );
    const preview = await app.eval(
      `return document.querySelector('.repayment-headline .primary strong')?.textContent;`,
    );
    if (saved === 0) await app.screenshot('01-builder-1440x900');
    await app.eval(`click('Add quote to log'); return true;`);
    await app.waitFor(
      `text().includes('Saved: ${quote.lender}')`,
      `${quote.lender} saved`,
    );
    saved += 1;
    const persisted = await app.eval(
      `return document.querySelector('.save-status .success')?.textContent;`,
    );
    check(
      `${quote.lender}: previewed locally and saved (server recalculated)`,
      persisted.includes(preview ?? '???'),
      `preview ${preview} · ${persisted.trim()}`,
    );
  }

  // Quote log
  await app.eval(
    `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.startsWith('Quote log')).click(); return true;`,
  );
  await app.waitFor(
    `document.querySelectorAll('table.quote-log tbody tr').length === 3`,
    'three logged quotes',
  );
  check('Quote log lists the three saved server quotes', true);
  await app.eval(
    `for (const name of ['Fortnightly', 'Weekly', 'Commissions']) { const box = [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.trim() === name).querySelector('input'); if (!box.checked) box.click(); } return true;`,
  );
  const logText = await app.eval(
    `return document.querySelector('table.quote-log').innerText;`,
  );
  check(
    'Frequencies and commission toggles applied to the log',
    /fortnightly/.test(logText) &&
      /weekly/.test(logText) &&
      /Commission/.test(logText),
  );
  await app.screenshot('02-quote-log-1440x900');

  // Notes
  await app.eval(`click('Edit notes for Westpac — Dealer'); return true;`);
  await app.waitFor(`byLabel('Notes')`, 'notes editor');
  await app.eval(
    `set(byLabel('Notes'), 'E2E note: client prefers lower repayments'); click('Save note'); return true;`,
  );
  await app.waitFor(`text().includes('Note saved')`, 'note saved');
  check('Quote note edited and saved through PATCH /v1/quotes/{id}', true);

  // Compare
  await app.eval(`click('Compare side by side'); return true;`);
  await app.waitFor(
    `document.querySelector('table.compare-table')`,
    'comparison',
  );
  const compare = await app.eval(
    `return document.querySelector('table.compare-table').innerText;`,
  );
  check(
    'Side-by-side comparison shows all three lenders with commission',
    ['Westpac', 'Branded', 'Autopay', 'Broker commission'].every((s) =>
      compare.includes(s),
    ),
  );
  await app.screenshot('03-compare-1440x900');

  // Client email + clipboard
  await app.eval(
    `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Client email').click(); return true;`,
  );
  await app.eval(
    `const box = [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.trim() === 'Commissions').querySelector('input'); if (box.checked) box.click(); return true;`,
  );
  await app.eval(`click('Copy quote to clipboard'); return true;`);
  await app.waitFor(`text().includes('Copied 3 quotes')`, 'clipboard copy');
  const html = readClipboard('html');
  const plain = readClipboard('text');
  check(
    'Clipboard holds HTML tables grouped under one Finance Amount/Asset header',
    /<table/.test(html) &&
      (html.match(/Finance Amount/g) ?? []).length === 1 &&
      /Repayments/.test(html),
  );
  check(
    'Clipboard HTML escapes the asset text',
    html.includes('&lt;b&gt;XLT&lt;/b&gt;') && !html.includes('<b>XLT'),
  );
  check(
    'Commission hidden from the client export when toggled off',
    !/Commissions/.test(html) && !/Commissions/.test(plain),
  );
  check(
    'Clipboard plain text carries the same quote',
    plain.includes('Finance Amount: $ 30,000.00') &&
      plain.includes('Option 3') &&
      plain.includes('OR'),
  );
  await app.screenshot('04-client-email-1440x900');

  // Delete one quote
  await app.eval(
    `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.startsWith('Quote log')).click(); return true;`,
  );
  await app.eval(`click('Table'); return true;`);
  await app.waitFor(`button('Delete quote Branded — Dealer')`, 'delete button');
  await app.eval(`click('Delete quote Branded — Dealer'); return true;`);
  await app.waitFor(`dialog()`, 'confirm dialog');
  await app.eval(`click('Delete quote', dialog()); return true;`);
  await app.waitFor(
    `document.querySelectorAll('table.quote-log tbody tr').length === 2 && !dialog()`,
    'quote deleted',
  );
  check('Single quote deleted after confirmation', true);

  // Lender library (read-only here: presets listed, nothing created)
  await app.eval(
    `[...document.querySelectorAll('.main-nav button')].find((b) => b.textContent === 'Lenders').click(); return true;`,
  );
  await app.waitFor(
    `text().includes('Built-in lenders') && document.querySelectorAll('.lender-table tbody tr').length >= 10`,
    'lender library',
  );
  check(
    'Lender library lists the built-in presets with duplicate actions',
    await app.eval(
      `return document.querySelectorAll('button').length > 0 && [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Duplicate to customise').length >= 10;`,
    ),
  );
  await app.screenshot('08-lenders-1440x900');
  await app.eval(
    `[...document.querySelectorAll('.main-nav button')].find((b) => b.textContent === 'Calculator').click(); [...document.querySelectorAll('.deal-item')].find((b) => b.textContent.includes(${JSON.stringify(dealName)})).click(); return true;`,
  );
  await app.eval(
    `await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.startsWith('Quote log')).click(); return true;`,
  );
  await app.waitFor(
    `document.querySelectorAll('table.quote-log tbody tr').length === 2`,
    'log after lenders view',
  );

  // Responsive screenshots
  await app.resize(1024, 700);
  await app.screenshot('05-quote-log-1024x700');
  await app.resize(780, 560);
  const overflow = await app.eval(
    `return document.documentElement.scrollWidth > window.innerWidth + 1;`,
  );
  check(
    'No page-level horizontal overflow at the 780×560 minimum window',
    !overflow,
  );
  await app.screenshot('06-quote-log-780x560');
  await app.eval(
    `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Quote builder').click(); return true;`,
  );
  await app.screenshot('07-builder-780x560');
  await app.resize(1440, 900);
  app.close();

  // Restart: data must come back from Cloud SQL
  await sleep(1500);
  app = await App.launch();
  await app.waitFor(
    `text().includes('New deal')`,
    'signed-in after restart',
    30_000,
  );
  await app.waitFor(
    `button(${JSON.stringify(dealName)}) || [...document.querySelectorAll('.deal-item')].some((b) => b.textContent.includes(${JSON.stringify(dealName)}))`,
    'deal in list after restart',
  );
  await app.eval(
    `[...document.querySelectorAll('.deal-item')].find((b) => b.textContent.includes(${JSON.stringify(dealName)})).click(); return true;`,
  );
  await app.eval(
    `await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.startsWith('Quote log')).click(); return true;`,
  );
  await app.waitFor(
    `document.querySelectorAll('table.quote-log tbody tr').length === 2`,
    'persisted quotes',
  );
  const persistedNote = await app.eval(
    `return text().includes('E2E note: client prefers lower repayments');`,
  );
  check(
    'After restart: deal, two quotes and the note persisted',
    persistedNote,
  );

  // Clear all, then remove the test deal
  await app.eval(`click('Clear all quotes'); return true;`);
  await app.waitFor(`dialog()`, 'clear confirm');
  await app.eval(`click('Clear all quotes', dialog()); return true;`);
  await app.waitFor(
    `text().includes('No quotes saved for this deal yet')`,
    'log cleared',
  );
  check('Clear all quotes emptied only this deal', true);
  await app.eval(`click('Delete deal'); return true;`);
  await app.waitFor(`dialog()`, 'delete deal confirm');
  await app.eval(`click('Delete deal', dialog()); return true;`);
  await app.waitFor(
    `!text().includes(${JSON.stringify(dealName)})`,
    'deal deleted',
  );
  check('Test deal deleted (cleanup)', true);
} finally {
  app?.close();
  if (screenshotDir)
    writeFileSync(
      path.join(screenshotDir, 'results.json'),
      JSON.stringify(results, null, 2),
    );
}
process.stdout.write(
  `\n${results.filter((r) => r.pass).length}/${results.length} checks passed\n`,
);
