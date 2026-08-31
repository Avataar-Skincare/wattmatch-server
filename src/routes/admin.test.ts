import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { signOrgToken } from '../lib/orgAuth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

const createdOrgIds: number[] = [];
let adminToken: string;
let generatorToken: string;

beforeAll(async () => {
  const { default: adminRouter } = await import('./admin.js');
  app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const admin = await Organization.create({ type: 'admin', name: 'Test Admin', contactEmail: `admin-test-${Date.now()}@test.local`, contactPhone: '9000000020' });
  const generator = await Organization.create({ type: 'generator', name: 'Test Generator', contactEmail: `gen-admin-test-${Date.now()}@test.local`, contactPhone: '9000000021' });
  createdOrgIds.push(admin.id, generator.id);
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
  generatorToken = await signOrgToken({ organizationId: generator.id, type: 'generator' });
});

afterAll(async () => {
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

// Every route in this module is gated identically (authRequired('admin')) — one representative
// route per response shape is enough to prove the gate is wired, not a full grid of all 5 routes.
describe('GET /admin/* — every route is admin-only', () => {
  for (const path of ['/api/admin/leads/ci', '/api/admin/leads/generator', '/api/admin/contact', '/api/admin/registrations/ci', '/api/admin/registrations/generator']) {
    it(`rejects ${path} with no token`, async () => {
      const res = await get(path);
      expect(res.status).toBe(401);
    });

    it(`rejects ${path} for a non-admin org`, async () => {
      const res = await get(path, generatorToken);
      expect(res.status).toBe(403);
    });

    it(`allows ${path} for an admin org`, async () => {
      const res = await get(path, adminToken);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  }
});
