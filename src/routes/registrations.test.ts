import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { GeneratorRegistration } from '../models/GeneratorRegistration.js';
import { CIRegistration } from '../models/CIRegistration.js';
import { Organization } from '../models/Organization.js';
import { TenderRequest } from '../models/TenderRequest.js';

// Previously had no test file at all (platform audit's M20 finding), same as
// vettingAuctionBridge.ts — these public, unauthenticated lead-capture routes had no rate limiting
// either (H5), fixed alongside this coverage.

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

const createdGeneratorRegIds: number[] = [];
const createdCiRegIds: number[] = [];
const createdOrgIds: number[] = [];
const createdTenderRequestIds: number[] = [];

beforeAll(async () => {
  const { default: registrationsRouter } = await import('./registrations.js');
  app = express();
  app.use(express.json());
  app.use('/api/registrations', registrationsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const id of createdTenderRequestIds) await TenderRequest.destroy({ where: { id } });
  for (const id of createdGeneratorRegIds) await GeneratorRegistration.destroy({ where: { id } });
  for (const id of createdCiRegIds) await CIRegistration.destroy({ where: { id } });
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

// POST /generator fires its account-creation call without awaiting it (fire-and-forget — the route
// doesn't wait on it before responding), so the Organization row can land slightly after the HTTP
// response does. Polling briefly rather than asserting immediately after the POST.
async function waitForOrg(email: string, timeoutMs = 2000): Promise<Organization | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const org = await Organization.findOne({ where: { contactEmail: email } });
    if (org) return org;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function trackOrgFor(email: string) {
  const org = await waitForOrg(email);
  if (org) createdOrgIds.push(org.id);
  return org;
}

describe('POST /registrations/generator', () => {
  it('rejects a submission missing required fields', async () => {
    const res = await post('/api/registrations/generator', { name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects an invalid email address', async () => {
    const res = await post('/api/registrations/generator', {
      name: 'Gen Owner', company: 'Gen Co', email: 'not-an-email', phone: '+919876543210',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/i);
  });

  it('saves a valid submission and creates a passwordless account for it', async () => {
    const email = uniqueEmail('gen-ok');
    const res = await post('/api/registrations/generator', {
      name: 'Gen Owner', company: 'Gen Co', email, phone: '+919876543210', state: 'Maharashtra', capacity: '5',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toEqual(expect.any(Number));
    createdGeneratorRegIds.push(res.body.id);

    const org = await trackOrgFor(email);
    expect(org).not.toBeNull();
    expect(org?.type).toBe('generator');
  });

  it('reuses the existing account rather than creating a second one for the same email', async () => {
    const email = uniqueEmail('gen-reuse');
    const first = await post('/api/registrations/generator', {
      name: 'Gen Owner', company: 'Gen Co', email, phone: '+919876543210', state: 'Maharashtra', capacity: '5',
    });
    createdGeneratorRegIds.push(first.body.id);
    const orgAfterFirst = await trackOrgFor(email);

    const second = await post('/api/registrations/generator', {
      name: 'Gen Owner Again', company: 'Gen Co', email, phone: '+919876543210', state: 'Maharashtra', capacity: '8',
    });
    expect(second.status).toBe(201);
    createdGeneratorRegIds.push(second.body.id);

    const allOrgsForEmail = await Organization.findAll({ where: { contactEmail: email } });
    expect(allOrgsForEmail).toHaveLength(1);
    expect(allOrgsForEmail[0]!.id).toBe(orgAfterFirst!.id);
  });
});

describe('POST /registrations/ci', () => {
  it('rejects a submission with consent not given', async () => {
    const email = uniqueEmail('ci-noconsent');
    const res = await post('/api/registrations/ci', {
      name: 'Buyer Owner', company: 'Buyer Co', email, phone: '+919876543211', state: 'Maharashtra', consent: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/consent/i);
  });

  it('saves a valid submission, creates an account, and auto-creates a pending TenderRequest', async () => {
    const email = uniqueEmail('ci-ok');
    const res = await post('/api/registrations/ci', {
      name: 'Buyer Owner', company: 'Buyer Co', email, phone: '+919876543211', state: 'Maharashtra',
      load: '100', targetCapacity: '2', message: 'Looking for solar', consent: true,
    });
    expect(res.status).toBe(201);
    createdCiRegIds.push(res.body.id);

    const org = await trackOrgFor(email);
    expect(org).not.toBeNull();
    expect(org?.type).toBe('buyer');

    const requests = await TenderRequest.findAll({ where: { buyerOrgId: org!.id } });
    expect(requests.length).toBeGreaterThan(0);
    createdTenderRequestIds.push(...requests.map((r) => r.id));
    expect(requests[0]!.status).toBe('pending');
    expect(Number(requests[0]!.requiredCapacityMw)).toBe(2);
  });
});

describe('rate limiting (H5 — previously these routes had none at all)', () => {
  it('eventually rejects with 429 under sustained repeated calls from the same caller', async () => {
    let sawTooManyRequests = false;
    for (let i = 0; i < 35; i++) {
      // Deliberately invalid (no email) — cheap to send, and still counted by the limiter, since
      // rate-limiting middleware runs before the route handler's own validation.
      const res = await post('/api/registrations/ci', { name: 'Spammer' });
      if (res.status === 429) {
        sawTooManyRequests = true;
        break;
      }
    }
    expect(sawTooManyRequests).toBe(true);
  });
});
