import { ConfigurationError, loadConfig } from './config.js';
import { createApplication } from './composition.js';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  // Names of invalid variables only; values may be secrets.
  process.stderr.write(
    `${error instanceof ConfigurationError ? error.message : 'Invalid configuration'}\n`,
  );
  process.exit(1);
}

const { app, database } = createApplication(config);
let closing = false;

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Shutting down');
  try {
    await app.close();
    await database.close();
  } catch {
    app.log.error({ code: 'SHUTDOWN_FAILED' }, 'Could not close cleanly');
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch {
  // Fastify may include socket or environment details in thrown errors.
  app.log.error({ code: 'STARTUP_FAILED' }, 'Could not start HTTP server');
  process.exitCode = 1;
}
