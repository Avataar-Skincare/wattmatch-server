import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { signOrgToken } from '../lib/orgAuth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

const createdOrgIds: number[] = [];

beforeAll(async () => {
  const { default: organizationsRouter } = await import('./organizations.js');
  app = express();
  app.use(express.json());
  app.use('/api', organizationsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
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

async function patch(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('GET/PATCH /organizations/me', () => {
  it('rejects with no token', async () => {
    const res = await get('/api/organizations/me');
    expect(res.status).toBe(401);
  });

  it('returns the authenticated org\'s own profile, including a null capacityMw for an auto-created generator with none set', async () => {
    const gen = await Organization.create({ type: 'generator', name: 'Auto Created', contactEmail: `me-test-${Date.now()}@test.local`, contactPhone: '9000000000' });
    createdOrgIds.push(gen.id);
    const token = await signOrgToken({ organizationId: gen.id, type: 'generator' });

    const res = await get('/api/organizations/me', token);
    expect(res.status).toBe(200);
    expect(res.body.organization.name).toBe('Auto Created');
    expect(res.body.organization.capacityMw).toBeNull();
  });

  it('lets a generator complete their profile, including capacityMw for the first time', async () => {
    const gen = await Organization.create({ type: 'generator', name: 'Needs Completion', contactEmail: `complete-test-${Date.now()}@test.local`, contactPhone: '9000000001' });
    createdOrgIds.push(gen.id);
    const token = await signOrgToken({ organizationId: gen.id, type: 'generator' });

    const res = await patch('/api/organizations/me', { name: 'Now Complete Co', contactPhone: '9999999999', capacityMw: 15 }, token);
    expect(res.status).toBe(200);
    expect(res.body.organization.name).toBe('Now Complete Co');
    expect(res.body.organization.capacityMw).toBe('15'); // as-set, before any DB round-trip reformats it

    const reloaded = await Organization.findByPk(gen.id);
    expect(reloaded!.contactPhone).toBe('9999999999');
  });

  it('rejects capacityMw for a buyer organization', async () => {
    const buyer = await Organization.create({ type: 'buyer', name: 'A Buyer', contactEmail: `buyer-me-test-${Date.now()}@test.local`, contactPhone: '9000000002' });
    createdOrgIds.push(buyer.id);
    const token = await signOrgToken({ organizationId: buyer.id, type: 'buyer' });

    const res = await patch('/api/organizations/me', { capacityMw: 10 }, token);
    expect(res.status).toBe(400);
  });

  it('only updates the fields actually provided, leaving the rest untouched', async () => {
    const gen = await Organization.create({ type: 'generator', name: 'Partial Update', contactEmail: `partial-test-${Date.now()}@test.local`, contactPhone: '9000000003' });
    createdOrgIds.push(gen.id);
    const token = await signOrgToken({ organizationId: gen.id, type: 'generator' });

    const res = await patch('/api/organizations/me', { capacityMw: 7 }, token);
    expect(res.status).toBe(200);
    expect(res.body.organization.name).toBe('Partial Update'); // unchanged
    expect(res.body.organization.contactPhone).toBe('9000000003'); // unchanged
    expect(res.body.organization.capacityMw).toBe('7');
  });
});

describe('POST /organizations/admin-invite', () => {
  it('rejects with no token', async () => {
    const res = await post('/api/organizations/admin-invite', { name: 'New Admin', email: `invitee-${Date.now()}@test.local`, phone: '9000000010' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin caller', async () => {
    const gen = await Organization.create({ type: 'generator', name: 'Not An Admin', contactEmail: `not-admin-${Date.now()}@test.local`, contactPhone: '9000000011' });
    createdOrgIds.push(gen.id);
    const token = await signOrgToken({ organizationId: gen.id, type: 'generator' });

    const res = await post('/api/organizations/admin-invite', { name: 'New Admin', email: `invitee-${Date.now()}@test.local`, phone: '9000000012' }, token);
    expect(res.status).toBe(403);
  });

  it('lets an admin create another admin, passwordless, pending a set-password email', async () => {
    const admin = await Organization.create({ type: 'admin', name: 'Existing Admin', contactEmail: `existing-admin-${Date.now()}@test.local`, contactPhone: '9000000013' });
    createdOrgIds.push(admin.id);
    const token = await signOrgToken({ organizationId: admin.id, type: 'admin' });

    const email = `invitee-${Date.now()}@test.local`;
    const res = await post('/api/organizations/admin-invite', { name: 'Invited Admin', email, phone: '9000000014' }, token);
    expect(res.status).toBe(200);
    createdOrgIds.push(res.body.organizationId);

    const created = await Organization.findByPk(res.body.organizationId);
    expect(created!.type).toBe('admin');
    expect(created!.contactEmail).toBe(email);
    expect(created!.passwordHash).toBeNull();
  });

  it('rejects inviting an email that already has an account', async () => {
    const admin = await Organization.create({ type: 'admin', name: 'Existing Admin 2', contactEmail: `existing-admin-2-${Date.now()}@test.local`, contactPhone: '9000000015' });
    createdOrgIds.push(admin.id);
    const token = await signOrgToken({ organizationId: admin.id, type: 'admin' });

    const res = await post('/api/organizations/admin-invite', { name: 'Duplicate', email: admin.contactEmail, phone: '9000000016' }, token);
    expect(res.status).toBe(409);
  });
});
