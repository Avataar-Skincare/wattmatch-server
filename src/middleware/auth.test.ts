import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { signOrgToken } from '../lib/orgAuth.js';
import { authRequired, optionalAuth } from './auth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
const createdOrgIds: number[] = [];

beforeAll(async () => {
  app = express();
  app.use(express.json());

  app.get('/any-authenticated', ...authRequired(), (req, res) => {
    res.json({ success: true, org: req.org });
  });
  app.get('/admin-only', ...authRequired('admin'), (req, res) => {
    res.json({ success: true, org: req.org });
  });
  app.get('/optional', optionalAuth, (req, res) => {
    res.json({ success: true, authenticated: Boolean(req.org) });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

describe('requireAuth / authRequired', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await get('/any-authenticated');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage/tampered token', async () => {
    const res = await get('/any-authenticated', 'not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and attaches req.org', async () => {
    const org = await Organization.create({ type: 'generator', name: 'Auth Test Gen', contactEmail: `auth-mw-${Date.now()}@test.local`, contactPhone: '9000000030' });
    createdOrgIds.push(org.id);
    const token = await signOrgToken({ organizationId: org.id, type: 'generator' });

    const res = await get('/any-authenticated', token);
    expect(res.status).toBe(200);
    expect(res.body.org).toMatchObject({ id: org.id, type: 'generator', name: 'Auth Test Gen', contactEmail: org.contactEmail });
  });

  it('rejects a token for an organization that no longer exists', async () => {
    const org = await Organization.create({ type: 'generator', name: 'Soon Deleted', contactEmail: `auth-mw-deleted-${Date.now()}@test.local`, contactPhone: '9000000031' });
    const token = await signOrgToken({ organizationId: org.id, type: 'generator' });
    await org.destroy();

    const res = await get('/any-authenticated', token);
    expect(res.status).toBe(401);
  });

  it('rejects a token whose claimed type no longer matches the organization\'s current type', async () => {
    const org = await Organization.create({ type: 'generator', name: 'Type Changed', contactEmail: `auth-mw-retyped-${Date.now()}@test.local`, contactPhone: '9000000032' });
    createdOrgIds.push(org.id);
    const token = await signOrgToken({ organizationId: org.id, type: 'generator' });
    // Simulates a token issued before a (hypothetical) role change — the org record itself is now
    // 'buyer', but the token still claims 'generator'.
    await org.update({ type: 'buyer' });

    const res = await get('/any-authenticated', token);
    expect(res.status).toBe(401);
  });
});

describe('requireRole via authRequired(...roles)', () => {
  it('rejects an authenticated org whose role is not in the allowed list', async () => {
    const org = await Organization.create({ type: 'generator', name: 'Wrong Role', contactEmail: `auth-mw-role-${Date.now()}@test.local`, contactPhone: '9000000033' });
    createdOrgIds.push(org.id);
    const token = await signOrgToken({ organizationId: org.id, type: 'generator' });

    const res = await get('/admin-only', token);
    expect(res.status).toBe(403);
  });

  it('allows an authenticated org whose role is in the allowed list', async () => {
    const org = await Organization.create({ type: 'admin', name: 'Right Role', contactEmail: `auth-mw-admin-${Date.now()}@test.local`, contactPhone: '9000000034' });
    createdOrgIds.push(org.id);
    const token = await signOrgToken({ organizationId: org.id, type: 'admin' });

    const res = await get('/admin-only', token);
    expect(res.status).toBe(200);
  });
});

describe('optionalAuth', () => {
  it('proceeds unauthenticated with no token, rather than rejecting', async () => {
    const res = await get('/optional');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it('proceeds unauthenticated (not rejected) with an invalid token', async () => {
    const res = await get('/optional', 'not-a-real-jwt');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it('attaches req.org when a valid token is present', async () => {
    const org = await Organization.create({ type: 'buyer', name: 'Optional Auth', contactEmail: `auth-mw-optional-${Date.now()}@test.local`, contactPhone: '9000000035' });
    createdOrgIds.push(org.id);
    const token = await signOrgToken({ organizationId: org.id, type: 'buyer' });

    const res = await get('/optional', token);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
  });
});
