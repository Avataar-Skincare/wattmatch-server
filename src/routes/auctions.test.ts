import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { Organization } from '../models/Organization.js';
import { signOrgToken } from '../lib/orgAuth.js';
import { signJoinToken, generateJti, verifyJoinToken } from '../lib/auctionTokens.js';
import { encryptField } from '../lib/fieldEncryption.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

const createdOrgIds: number[] = [];
const createdAuctionIds: number[] = [];

let generatorOrgId: number;
let generatorToken: string;
let buyerOrgId: number;
let buyerToken: string;
let adminToken: string;

beforeAll(async () => {
  const { default: auctionsRouter } = await import('./auctions.js');
  app = express();
  app.use(express.json());
  app.use('/api', auctionsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const generator = await Organization.create({ type: 'generator', name: 'Auctions Test Gen', contactEmail: `auctions-gen-${Date.now()}@test.local`, contactPhone: '9000000040' });
  const buyer = await Organization.create({ type: 'buyer', name: 'Auctions Test Buyer', contactEmail: `auctions-buyer-${Date.now()}@test.local`, contactPhone: '9000000041' });
  const admin = await Organization.create({ type: 'admin', name: 'Auctions Test Admin', contactEmail: `auctions-admin-${Date.now()}@test.local`, contactPhone: '9000000042' });
  createdOrgIds.push(generator.id, buyer.id, admin.id);
  generatorOrgId = generator.id;
  buyerOrgId = buyer.id;
  generatorToken = await signOrgToken({ organizationId: generator.id, type: 'generator' });
  buyerToken = await signOrgToken({ organizationId: buyer.id, type: 'buyer' });
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
});

afterAll(async () => {
  for (const id of createdAuctionIds) {
    await AuctionParticipant.destroy({ where: { auctionId: id } });
    await Auction.destroy({ where: { id } });
  }
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

async function makeAuction(): Promise<number> {
  const auction = await Auction.create({
    title: `Auctions route test ${Date.now()}`,
    status: 'live',
    openingBid: '10.0000',
    windowSeconds: 480,
    maxAutoExtensions: 8,
    minUndercut: '0.01',
  });
  createdAuctionIds.push(auction.id);
  return auction.id;
}

describe('GET /auctions/mine', () => {
  it('rejects with no token', async () => {
    const res = await get('/api/auctions/mine');
    expect(res.status).toBe(401);
  });

  it('lists auctions the org has a real, org-backed seat in, and nothing else', async () => {
    const auctionId = await makeAuction();
    const scheduledStartAt = new Date(Date.now() + 60 * 60 * 1000);
    await Auction.update({ scheduledStartAt }, { where: { id: auctionId } });
    await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Auctions Test Gen'),
      organizationId: generatorOrgId,
      alias: 'GEN-MINE',
      role: 'generator',
      joinTokenId: generateJti(),
    });
    // A legacy/manual-seed seat (organizationId: null) for the same org's alias should never show
    // up here — this route is scoped to real org-backed membership only, same as /join.
    const otherAuctionId = await makeAuction();
    await AuctionParticipant.create({
      auctionId: otherAuctionId,
      organizationName: await encryptField('Legacy Demo Gen'),
      organizationId: null,
      alias: 'GEN-LEGACY',
      role: 'generator',
      joinTokenId: generateJti(),
    });

    const res = await get('/api/auctions/mine', generatorToken);
    expect(res.status).toBe(200);
    expect(res.body.auctions).toHaveLength(1);
    expect(res.body.auctions[0]).toMatchObject({ auctionId, alias: 'GEN-MINE', role: 'generator' });
    // MySQL's DATETIME column stores whole-second precision, not milliseconds — compare at that
    // granularity rather than expecting an exact millisecond match.
    expect(Math.floor(new Date(res.body.auctions[0].scheduledStartAt).getTime() / 1000)).toBe(Math.floor(scheduledStartAt.getTime() / 1000));
  });

  it('returns an empty list for an org with no auction seats at all', async () => {
    const res = await get('/api/auctions/mine', buyerToken);
    expect(res.status).toBe(200);
    expect(res.body.auctions).toEqual([]);
  });
});

describe('POST /auctions/:id/join', () => {
  it('rejects with no token', async () => {
    const auctionId = await makeAuction();
    const res = await post(`/api/auctions/${auctionId}/join`, {});
    expect(res.status).toBe(401);
  });

  it('rejects an admin org (only generator/buyer may join)', async () => {
    const auctionId = await makeAuction();
    const res = await post(`/api/auctions/${auctionId}/join`, {}, adminToken);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-existent auction', async () => {
    const res = await post('/api/auctions/999999999/join', {}, generatorToken);
    expect(res.status).toBe(404);
  });

  it('rejects a generator with no AuctionParticipant seat for this auction', async () => {
    const auctionId = await makeAuction();
    const res = await post(`/api/auctions/${auctionId}/join`, {}, generatorToken);
    expect(res.status).toBe(403);
  });

  it('mints a valid, verifiable socket token for an invited generator', async () => {
    const auctionId = await makeAuction();
    const participant = await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Auctions Test Gen'),
      organizationId: generatorOrgId,
      alias: 'GEN-JOIN',
      role: 'generator',
      joinTokenId: generateJti(),
    });

    const res = await post(`/api/auctions/${auctionId}/join`, {}, generatorToken);
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('GEN-JOIN');
    expect(res.body.role).toBe('generator');

    const decoded = await verifyJoinToken(res.body.token);
    expect(decoded.auctionId).toBe(auctionId);
    expect(decoded.participantId).toBe(participant.id);
    expect(decoded.jti).toBe(participant.joinTokenId);
  });

  it('lets an invited buyer join their read-only seat', async () => {
    const auctionId = await makeAuction();
    await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Auctions Test Buyer'),
      organizationId: buyerOrgId,
      alias: 'BUYER',
      role: 'buyer',
      joinTokenId: generateJti(),
    });

    const res = await post(`/api/auctions/${auctionId}/join`, {}, buyerToken);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('buyer');
  });
});

describe('GET /auctions/:id/winner-identity', () => {
  it('rejects with no credentials', async () => {
    const auctionId = await makeAuction();
    const res = await get(`/api/auctions/${auctionId}/winner-identity`);
    expect(res.status).toBe(401);
  });

  it('rejects while the auction is still live', async () => {
    const auctionId = await makeAuction();
    await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Auctions Test Gen'),
      organizationId: generatorOrgId,
      alias: 'GEN-LIVE',
      role: 'generator',
      joinTokenId: generateJti(),
    });
    const res = await get(`/api/auctions/${auctionId}/winner-identity`, generatorToken);
    expect(res.status).toBe(409);
  });

  it('reveals the counterparty to the winning generator via org login, and rejects a losing generator', async () => {
    const auctionId = await makeAuction();
    const winner = await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Auctions Test Gen'),
      organizationId: generatorOrgId,
      alias: 'GEN-WINNER',
      role: 'generator',
      joinTokenId: generateJti(),
    });
    const buyerSeat = await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Auctions Test Buyer'),
      organizationId: buyerOrgId,
      alias: 'BUYER',
      role: 'buyer',
      joinTokenId: generateJti(),
    });
    const loser = await Organization.create({ type: 'generator', name: 'Losing Gen', contactEmail: `losing-gen-${Date.now()}@test.local`, contactPhone: '9000000043' });
    createdOrgIds.push(loser.id);
    const loserToken = await signOrgToken({ organizationId: loser.id, type: 'generator' });
    await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Losing Gen'),
      organizationId: loser.id,
      alias: 'GEN-LOSER',
      role: 'generator',
      joinTokenId: generateJti(),
    });

    await Auction.update({ status: 'closed', winnerParticipantId: winner.id }, { where: { id: auctionId } });

    const winnerRes = await get(`/api/auctions/${auctionId}/winner-identity`, generatorToken);
    expect(winnerRes.status).toBe(200);
    expect(winnerRes.body.alias).toBe(buyerSeat.alias);
    expect(winnerRes.body.organizationName).toBe('Auctions Test Buyer');

    const buyerRes = await get(`/api/auctions/${auctionId}/winner-identity`, buyerToken);
    expect(buyerRes.status).toBe(200);
    expect(buyerRes.body.alias).toBe('GEN-WINNER');

    const loserRes = await get(`/api/auctions/${auctionId}/winner-identity`, loserToken);
    expect(loserRes.status).toBe(403);
  });

  it('falls back to a legacy join token for a manual-seed participant with no organizationId', async () => {
    const auctionId = await makeAuction();
    const jti = generateJti();
    const legacyWinner = await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Legacy Demo Gen'),
      organizationId: null,
      alias: 'LEGACY-WINNER',
      role: 'generator',
      joinTokenId: jti,
    });
    const legacyToken = await signJoinToken({ auctionId, participantId: legacyWinner.id, alias: 'LEGACY-WINNER', jti });

    await Auction.update({ status: 'closed', winnerParticipantId: legacyWinner.id }, { where: { id: auctionId } });

    const res = await get(`/api/auctions/${auctionId}/winner-identity`, legacyToken);
    // No buyer seat on this auction, so the winner has nothing to reveal — confirms the legacy
    // token was accepted as a valid credential (past the auth check) and reached that business rule,
    // not that it was rejected outright.
    expect(res.status).toBe(404);
  });
});
