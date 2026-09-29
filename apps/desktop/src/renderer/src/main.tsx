import React from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { Shell } from './app/shell';
import { AuthGate } from './auth-gate';
import { BridgeProvider } from './lib/bridge';
import './styles.css';

// The CSP forbids eval; zod's JIT would only probe for it and fall back.
z.config({ jitless: true });

const root = document.getElementById('root');
if (root === null) throw new Error('Desktop root element is missing');
const bridge = window.swyft;
createRoot(root).render(
  <React.StrictMode>
    <AuthGate auth={bridge?.auth}>
      {(user, signOut) =>
        bridge && (
          <BridgeProvider bridge={bridge}>
            <Shell user={user} onSignOut={signOut} />
          </BridgeProvider>
        )
      }
    </AuthGate>
  </React.StrictMode>,
);
