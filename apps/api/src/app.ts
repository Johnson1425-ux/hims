/**
 * Express application assembly.
 *
 * Middleware ORDER is load-bearing. Reading top to bottom: identify the
 * request, harden the response, parse the body, limit the rate, route, then
 * translate whatever came back out. The error handler must be last, and the
 * audit flush must be registered before the routes so its `finish` listener is
 * attached before any handler can respond.
 */
import express, { type Express } from 'express';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, isProduction } from './config/env.js';
import { logger } from './utils/logger.js';
import { requestContext } from './middleware/request-context.js';
import { corsOptions, securityHeaders } from './middleware/security-headers.js';
import { auditFlush } from './middleware/audit.js';
import { apiLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { apiRouter } from './modules/index.js';
import { checkDatabase } from './db/pool.js';

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, req.ip must reflect X-Forwarded-For or every rate
  // limit keys on the proxy's address and throttles the whole hospital at once.
  if (isProduction) {
    app.set('trust proxy', 1);
  }

  app.disable('x-powered-by');
  app.disable('etag'); // No conditional caching of PHI responses.

  app.use(requestContext);
  app.use(...securityHeaders());
  app.use(cors(corsOptions));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { requestId?: string }).requestId ?? 'unknown',
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        // Health checks at info level would drown everything else.
        return 'debug';
      },
      customProps: (req) => ({
        userId: (req as { principal?: { userId: string } }).principal?.userId,
        tenantId: (req as { principal?: { tenantId: string } }).principal?.tenantId,
      }),
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/health/ready',
      },
    }),
  );

  // 1 MB is ample for clinical JSON. Documents and images go to object storage
  // through presigned URLs, never through this process.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(compression());

  // ---- Health probes, before auth and rate limiting ------------------------
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'hims-api', timestamp: new Date().toISOString() });
  });

  // Readiness fails when the database is unreachable, so the orchestrator stops
  // sending traffic instead of serving 500s.
  app.get('/health/ready', async (_req, res) => {
    const db = await checkDatabase();
    res.status(db.ok ? 200 : 503).json({
      status: db.ok ? 'ready' : 'unavailable',
      checks: { database: db },
    });
  });

  // ---- API -----------------------------------------------------------------
  app.use(auditFlush());
  app.use('/api/v1', apiLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export { env };
