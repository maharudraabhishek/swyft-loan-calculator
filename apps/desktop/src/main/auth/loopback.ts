import { createServer, type Server } from 'node:http';

export type LoopbackResult =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'denied' }
  | { readonly kind: 'timeout' };

export interface LoopbackReceiver {
  /** `http://127.0.0.1:<port>/callback`, registered with the login attempt. */
  readonly redirectUri: string;
  readonly result: Promise<LoopbackResult>;
  close(): void;
}

const page = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Swyft Finance</title>` +
  `<style>body{font-family:system-ui,sans-serif;margin:20vh auto;max-width:28rem;color:#16324f}</style>` +
  `</head><body><h1>Swyft Finance</h1><p>${message}</p></body></html>`;

/**
 * RFC 8252 loopback receiver for the sign-in redirect. Binds 127.0.0.1 only (no firewall
 * prompt, unreachable from the network), accepts only `/callback` with this attempt's
 * `state`, answers once, then closes. Requests with a wrong state are ignored so a
 * forged or stale redirect cannot end the attempt.
 */
export async function startLoopbackReceiver(
  expectedState: string,
  timeoutMs: number,
): Promise<LoopbackReceiver> {
  let settle: (result: LoopbackResult) => void = () => undefined;
  const result = new Promise<LoopbackResult>((resolve) => {
    settle = resolve;
  });
  function finish(outcome: LoopbackResult): void {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    settle(outcome);
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, message: string) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'",
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      response.end(page(message));
    };
    if (request.method !== 'GET' || url.pathname !== '/callback')
      return send(404, 'Not found.');
    if (url.searchParams.get('state') !== expectedState)
      return send(400, 'This sign-in link is not for the current attempt.');
    const code = url.searchParams.get('code');
    if (code && /^swc_[A-Za-z0-9_-]{20,128}$/.test(code)) {
      send(
        200,
        'You are signed in. You can close this tab and return to Swyft Finance.',
      );
      finish({ kind: 'code', code });
    } else {
      send(
        200,
        'Sign-in was cancelled. You can close this tab and try again from Swyft Finance.',
      );
      finish({ kind: 'denied' });
    }
  });

  const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    finish({ kind: 'timeout' });
    throw new Error('Loopback listener has no port');
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    result,
    close: () => finish({ kind: 'timeout' }),
  };
}
