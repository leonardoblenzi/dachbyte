import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env, corsOrigins } from './config/env';
import { pool } from './db/pool';
import { authenticate } from './http/authenticate';
import { registerErrorHandler } from './http/errors';
import { authRoutes } from './modules/auth/auth.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { facilityRoutes } from './modules/facilities/facilities.routes';
import { labelRoutes } from './modules/labels/labels.routes';
import { productRoutes } from './modules/products/products.routes';
import { scanRoutes } from './modules/scan/scan.routes';
import { stockRoutes } from './modules/stock/stock.routes';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug'
    }
  });

  await app.register(helmet, {
    global: true
  });
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true
  });
  await app.register(jwt, {
    secret: env.JWT_SECRET
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Volt Stock API',
        description: 'API multitenant para estoque visual, QR Code, bipagem e auditoria.',
        version: '0.1.0'
      }
    }
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs'
  });

  registerErrorHandler(app);

  app.get('/health', async () => {
    const db = await pool.query('SELECT 1 AS ok');
    return {
      ok: true,
      service: 'voltstock-api',
      db: db.rows[0].ok === 1
    };
  });

  await app.register(authRoutes, { prefix: '/v1/auth' });

  await app.register(
    async (protectedApp) => {
      protectedApp.addHook('preHandler', authenticate);
      protectedApp.get('/me', async (request) => ({ user: request.auth }));
      await protectedApp.register(dashboardRoutes);
      await protectedApp.register(facilityRoutes);
      await protectedApp.register(labelRoutes);
      await protectedApp.register(productRoutes);
      await protectedApp.register(scanRoutes);
      await protectedApp.register(stockRoutes);
    },
    { prefix: '/v1' }
  );

  return app;
}

async function start() {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
