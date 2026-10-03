/**
 * Process entry point.
 *
 * Shutdown is graceful on purpose: a SIGTERM during a rolling deploy must not
 * abort a transaction that is part-way through writing an encounter. The server
 * stops accepting connections, lets in-flight requests finish, then drains the
 * pool.
 */
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { checkDatabase, closePool } from './db/pool.js';
import { evictAllDataKeys } from './security/crypto.js';

const app = createApp();
const server = createServer(app);

// Longer than the load balancer's idle timeout, so the balancer closes
// connections rather than racing the server to it.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

async function start(): Promise<void> {
  const db = await checkDatabase();

  if (!db.ok) {
    // Better to fail the deploy than to serve a hospital 500s.
    logger.fatal('cannot reach the database; refusing to start');
    process.exit(1);
  }

  server.listen(env.API_PORT, () => {
    logger.info(
      { port: env.API_PORT, env: env.NODE_ENV, dbLatencyMs: db.latencyMs },
      'HIMS API listening',
    );
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');

  // Stop accepting new connections; the callback fires once the last in-flight
  // request has completed.
  server.close(async () => {
    try {
      await closePool();
      // Zero the unwrapped tenant keys rather than leaving them in a heap
      // snapshot or core dump.
      evictAllDataKeys();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  });

  // Hard ceiling: a stuck request must not block the deploy indefinitely.
  setTimeout(() => {
    logger.error('shutdown timed out after 30s; forcing exit');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  // The process state is unknown after this point; continuing risks writing
  // corrupt data to a patient record.
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException');
});

void start();
