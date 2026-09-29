// End-to-end smoke test against a deployed API with real Google sign-in.
//
//   node apps/api/scripts/cloud-smoke.mjs https://<service-url> [--two-users]
//
// Acts as the desktop client (RFC 8252 loopback + PKCE + system browser), then exercises
// deals, quotes, quote log, presets, per-user fee signatures, real Cloud Storage logos,
// rotation and logout. With --two-users a second Google account signs in and every
// cross-user access to the first user's data must fail. Tokens stay in memory, never printed.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';

const base = new URL(process.argv[2] ?? '').origin;
const twoUsers = process.argv.includes('--two-users');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}\n`,
  );
};

function openBrowser(url) {
  // rundll32 hands the URL to the default browser without shell parsing of '&'.
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function signIn(label) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');
  let resolveCode;
  const codePromise = new Promise((resolve) => (resolveCode = resolve));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (
      url.pathname !== '/callback' ||
      url.searchParams.get('state') !== state
    ) {
      response.writeHead(400).end('Unexpected request');
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<p>Smoke test signed in. You can close this tab.</p>');
    resolveCode(
      url.searchParams.get('code') ?? `error:${url.searchParams.get('error')}`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const login = new URL('/v1/auth/login', base);
  login.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  process.stdout.write(
    `\n>>> ${label}: complete Google sign-in in your browser...\n`,
  );
  openBrowser(login.href);
  const code = await Promise.race([
    codePromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('sign-in timed out')), 300_000),
    ),
  ]);
  server.close();
  if (code.startsWith('error:')) throw new Error(`sign-in refused: ${code}`);
  const tokenResponse = await fetch(new URL('/v1/auth/token', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantType: 'authorization_code',
      code,
      codeVerifier: verifier,
      redirectUri,
    }),
  });
  check(
    `${label}: PKCE code exchange`,
    tokenResponse.status === 200,
    String(tokenResponse.status),
  );
  const tokens = await tokenResponse.json();
  const replay = await fetch(new URL('/v1/auth/token', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantType: 'authorization_code',
      code,
      codeVerifier: verifier,
      redirectUri,
    }),
  });
  check(
    `${label}: authorization code cannot be replayed`,
    replay.status === 401,
  );
  return tokens;
}

function client(tokens) {
  return async (method, path, body, headers = {}) => {
    const isJson = body !== undefined && !Buffer.isBuffer(body);
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        ...(isJson ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: isJson ? JSON.stringify(body) : body }),
    });
    const type = response.headers.get('content-type') ?? '';
    const data = type.includes('json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, headers: response.headers };
  };
}

// 1×1 PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

try {
  check(
    'anonymous request rejected',
    (await fetch(new URL('/v1/deals', base))).status === 401,
  );
  check(
    'forged bearer rejected',
    (
      await fetch(new URL('/v1/me', base), {
        headers: { authorization: `Bearer swa_${'x'.repeat(43)}` },
      })
    ).status === 401,
  );

  let tokens = await signIn('user A');
  let api = client(tokens);
  const me = await api('GET', '/v1/me');
  check(
    'real Google identity via Identity Platform',
    me.status === 200 && me.data.email === tokens.user.email,
    me.data.email,
  );

  const lenders = await api('GET', '/v1/lenders');
  const signatures = await api('GET', '/v1/fee-signatures');
  check(
    'lender presets and fee signatures served from Cloud SQL',
    lenders.data.items.filter((l) => l.isPreset).length === 6 &&
      signatures.data.items.filter((s) => s.isPreset).length === 10,
  );

  const deal = await api('POST', '/v1/deals', {
    name: `Cloud smoke ${new Date().toISOString()}`,
  });
  check(
    'create deal (with its quote log)',
    deal.status === 201 && Boolean(deal.data.quoteLogId),
  );
  const list = await api('GET', '/v1/deals?limit=5');
  check(
    'list deals',
    list.status === 200 && list.data.items.some((d) => d.id === deal.data.id),
  );

  const quoteBody = {
    feeSignatureId: '00000000-0000-4000-8000-000000000301',
    assetDescription: 'New Land Rover Defender',
    financeAmount: '30000',
    termMonths: 60,
    baseRate: '0.085',
    commissionRate: '0.04',
  };
  const key = `smoke-${randomBytes(8).toString('hex')}`;
  const quote = await api(
    'POST',
    `/v1/deals/${deal.data.id}/quotes`,
    quoteBody,
    { 'idempotency-key': key },
  );
  check(
    'save quote: server recalculation (Westpac Dealer preset)',
    quote.status === 201 &&
      quote.data.netAmountFinanced === '30500.00' &&
      quote.data.commission === '1220.00',
    `${quote.data.monthlyPayment}/month, comparison ${quote.data.comparisonRate}`,
  );
  const retry = await api(
    'POST',
    `/v1/deals/${deal.data.id}/quotes`,
    quoteBody,
    { 'idempotency-key': key },
  );
  check(
    'idempotent retry returns the same quote',
    retry.status === 200 && retry.data.id === quote.data.id,
  );
  const forged = await api(
    'POST',
    `/v1/deals/${deal.data.id}/quotes`,
    { ...quoteBody, monthlyPayment: '1.00' },
    {
      'idempotency-key': `${key}-x`,
    },
  );
  check('client-supplied results rejected', forged.status === 400);
  const noted = await api('PATCH', `/v1/quotes/${quote.data.id}`, {
    notes: 'Cloud smoke note',
  });
  check(
    'notes editable, calculation unchanged',
    noted.status === 200 &&
      noted.data.notes === 'Cloud smoke note' &&
      noted.data.monthlyPayment === quote.data.monthlyPayment,
  );
  const log = await api('GET', `/v1/deals/${deal.data.id}/quotes`);
  check(
    'quote log lists the deal quotes',
    log.status === 200 && log.data.items.length === 1,
  );

  const copy = await api('POST', '/v1/fee-signatures', {
    copyFromId: '00000000-0000-4000-8000-000000000301',
    name: 'My Westpac',
  });
  check(
    'per-user fee signature copied from preset',
    copy.status === 201 && copy.data.isPreset === false,
  );
  const lender = await api('POST', '/v1/lenders', {
    name: `Smoke Lender ${randomBytes(3).toString('hex')}`,
  });
  check('create custom lender', lender.status === 201);
  const upload = await api('PUT', `/v1/lenders/${lender.data.id}/logo`, png, {
    'content-type': 'image/png',
  });
  check(
    'upload logo to Cloud Storage through API',
    upload.status === 200 && upload.data.hasLogo === true,
  );
  const download = await api('GET', `/v1/lenders/${lender.data.id}/logo`);
  check(
    'download logo through API',
    download.status === 200 && Buffer.compare(download.data, png) === 0,
  );
  const svg = await api(
    'PUT',
    `/v1/lenders/${lender.data.id}/logo`,
    Buffer.from('<svg/>'),
    {
      'content-type': 'image/svg+xml',
    },
  );
  check('SVG upload refused', svg.status === 415);
  const large = await api(
    'PUT',
    `/v1/lenders/${lender.data.id}/logo`,
    Buffer.concat([png, Buffer.alloc(600 * 1024)]),
    {
      'content-type': 'image/png',
    },
  );
  check('oversized upload refused', large.status === 413);
  const preset = await api(
    'PUT',
    '/v1/lenders/00000000-0000-4000-8000-000000000001/logo',
    png,
    {
      'content-type': 'image/png',
    },
  );
  check('preset lender logo not writable', preset.status === 404);

  if (twoUsers) {
    const tokensB = await signIn('user B (use a DIFFERENT Google account)');
    const apiB = client(tokensB);
    const meB = await apiB('GET', '/v1/me');
    check(
      'user B is a different user',
      meB.status === 200 && meB.data.id !== me.data.id,
      meB.data.email,
    );
    const probes = [
      ['GET', `/v1/deals/${deal.data.id}`],
      ['GET', `/v1/deals/${deal.data.id}/quotes`],
      ['GET', `/v1/quotes/${quote.data.id}`],
      ['PATCH', `/v1/quotes/${quote.data.id}`, { notes: 'stolen' }],
      ['DELETE', `/v1/quotes/${quote.data.id}`],
      ['DELETE', `/v1/deals/${deal.data.id}`],
      ['GET', `/v1/fee-signatures/${copy.data.id}`],
      ['GET', `/v1/lenders/${lender.data.id}/logo`],
      ['DELETE', `/v1/lenders/${lender.data.id}`],
    ];
    const statuses = [];
    for (const [method, path, body] of probes)
      statuses.push((await apiB(method, path, body)).status);
    check(
      "user B cannot read or change user A's data (all 404)",
      statuses.every((s) => s === 404),
      statuses.join(','),
    );
    const dealsB = await apiB('GET', '/v1/deals?limit=100');
    check(
      "user A's deal absent from user B's list",
      !dealsB.data.items.some((d) => d.id === deal.data.id),
    );
    const borrowed = await apiB('POST', '/v1/deals', { name: 'B deal' });
    const useA = await apiB(
      'POST',
      `/v1/deals/${borrowed.data.id}/quotes`,
      { ...quoteBody, feeSignatureId: copy.data.id },
      { 'idempotency-key': `${key}-b` },
    );
    check(
      "user B cannot price with user A's fee signature",
      useA.status === 400,
    );
    await apiB('DELETE', `/v1/deals/${borrowed.data.id}`);
    await fetch(new URL('/v1/auth/logout', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokensB.refreshToken }),
    });
    const stillThere = await api('GET', `/v1/quotes/${quote.data.id}`);
    check(
      "user A's data intact after user B's attempts",
      stillThere.status === 200 && stillThere.data.notes === 'Cloud smoke note',
    );
  }

  const rotated = await fetch(new URL('/v1/auth/token', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantType: 'refresh_token',
      refreshToken: tokens.refreshToken,
    }),
  });
  const next = await rotated.json();
  check(
    'refresh token rotation',
    rotated.status === 200 && next.refreshToken !== tokens.refreshToken,
  );
  check(
    'previous access token invalid after rotation',
    (await api('GET', '/v1/me')).status === 401,
  );
  tokens = next;
  api = client(tokens);

  check(
    'delete logo',
    (await api('DELETE', `/v1/lenders/${lender.data.id}/logo`)).status === 204,
  );
  check(
    'delete custom lender',
    (await api('DELETE', `/v1/lenders/${lender.data.id}`)).status === 204,
  );
  check(
    'delete fee signature copy',
    (await api('DELETE', `/v1/fee-signatures/${copy.data.id}`)).status === 204,
  );
  check(
    'clear quote log',
    (await api('DELETE', `/v1/deals/${deal.data.id}/quotes`)).data.deleted ===
      1,
  );
  check(
    'delete deal',
    (await api('DELETE', `/v1/deals/${deal.data.id}`)).status === 204,
  );

  const logout = await fetch(new URL('/v1/auth/logout', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  });
  check('logout', logout.status === 204);
  check(
    'access token rejected after logout',
    (await api('GET', '/v1/me')).status === 401,
  );
  const afterLogout = await fetch(new URL('/v1/auth/token', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantType: 'refresh_token',
      refreshToken: tokens.refreshToken,
    }),
  });
  check('refresh token rejected after logout', afterLogout.status === 401);
} catch (error) {
  check(
    'smoke run completed',
    false,
    error instanceof Error ? error.message : String(error),
  );
}
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(
  `\n${results.length - failed}/${results.length} checks passed\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
