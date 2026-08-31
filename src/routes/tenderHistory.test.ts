import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { AuctionBid } from '../models/AuctionBid.js';
import { signOrgToken } from '../lib/orgAuth.js';
import { encryptField } from '../lib/fieldEncryption.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let adminToken: string;
let buyerOrgId: number;
let winnerOrgId: number;

const createdOrgIds: number[] = [];
const createdTenderIds: number[] = [];
const createdAuctionIds: number[] = [];

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const { default: tendersRouter } = await import('./tenders.js');
  app = express();
  app.use(express.json());
  app.use('/api', tendersRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const admin = await Organization.create({ type: 'admin', name: 'History Test Admin', contactEmail: `history-admin-${Date.now()}@test.local`, contactPhone: '9000000000' });
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
  createdOrgIds.push(admin.id);

  const buyer = await Organization.create({ type: 'buyer', name: 'History Test Buyer', contactEmail: `history-buyer-${Date.now()}@test.local`, contactPhone: '9000000001' });
  buyerOrgId = buyer.id;
  createdOrgIds.push(buyer.id);

  const winnerOrg = await Organization.create({ type: 'generator', name: 'History Test Winning Generator', contactEmail: `history-winner-${Date.now()}@test.local`, contactPhone: '9000000002' });
  winnerOrgId = winnerOrg.id;
  createdOrgIds.push(winnerOrg.id);
});

afterAll(async () => {
  for (const id of createdAuctionIds) {
    await AuctionBid.destroy({ where: { auctionId: id } });
    await AuctionParticipant.destroy({ where: { auctionId: id } });
    await Auction.destroy({ where: { id } });
  }
  for (const id of createdTenderIds) await Tender.destroy({ where: { id } });
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /tenders/history', () => {
  it('is admin-only', async () => {
    const res = await get('/api/tenders/history');
    expect(res.status).toBe(401);
  });

  it('shows a never-promoted tender with its buyer and no auction', async () => {
    const tender = await Tender.create({ buyerOrgId, title: `History unpromoted ${Date.now()}`, requiredCapacityMw: '5' });
    createdTenderIds.push(tender.id);

    const res = await get('/api/tenders/history', adminToken);
    expect(res.status).toBe(200);
    const entry = res.body.tenders.find((t: { id: number }) => t.id === tender.id);
    expect(entry).toBeTruthy();
    expect(entry.buyer).toEqual({ id: buyerOrgId, name: 'History Test Buyer', email: expect.stringContaining('history-buyer-') });
    expect(entry.auction).toBeNull();
  });

  it('resolves the real winning organization name and winning price for a closed, promoted tender', async () => {
    const tender = await Tender.create({ buyerOrgId, title: `History closed ${Date.now()}`, requiredCapacityMw: '5' });
    createdTenderIds.push(tender.id);

    const auction = await Auction.create({
      title: `Auction for tender ${tender.id}`,
      status: 'closed',
      openingBid: '6.5000',
      currentLowestBid: '5.7500',
      windowSeconds: 300,
      maxAutoExtensions: 8,
      minUndercut: '0.01',
      tenderRef: tender.id,
    });
    createdAuctionIds.push(auction.id);

    const winnerParticipant = await AuctionParticipant.create({
      auctionId: auction.id,
      organizationName: await encryptField('History Test Winning Generator'),
      organizationId: winnerOrgId,
      alias: 'GEN-1',
      role: 'generator',
      joinTokenId: `history-test-jti-${Date.now()}`,
    });
    await Auction.update({ winnerParticipantId: winnerParticipant.id }, { where: { id: auction.id } });

    // A losing, earlier bid plus the actual winning (last accepted) bid — proves the route picks
    // the LAST accepted AuctionBid for this auction as the winner's raw rate/returnPercent, not
    // just any accepted row.
    await AuctionBid.create({ auctionId: auction.id, participantId: 999, alias: 'GEN-OTHER', amount: '6.0000', rate: '6.0000', returnPercent: '0.00', accepted: true, rejectReason: null, ipHash: null, prevHash: '', hash: 'h1' });
    await AuctionBid.create({ auctionId: auction.id, participantId: winnerParticipant.id, alias: 'GEN-1', amount: '5.7500', rate: '9.5000', returnPercent: '40.00', accepted: true, rejectReason: null, ipHash: null, prevHash: 'h1', hash: 'h2' });

    const res = await get('/api/tenders/history', adminToken);
    expect(res.status).toBe(200);
    const entry = res.body.tenders.find((t: { id: number }) => t.id === tender.id);
    expect(entry.auction).toMatchObject({
      id: auction.id,
      status: 'closed',
      winningBid: '5.7500',
      winner: { alias: 'GEN-1', organizationName: 'History Test Winning Generator', rate: '9.5000', returnPercent: '40.00' },
    });
  });

  it('shows a promoted-but-not-closed auction with no winner yet', async () => {
    const tender = await Tender.create({ buyerOrgId, title: `History live ${Date.now()}`, requiredCapacityMw: '5' });
    createdTenderIds.push(tender.id);

    const auction = await Auction.create({
      title: `Auction for tender ${tender.id}`,
      status: 'live',
      openingBid: '6.5000',
      currentLowestBid: '6.5000',
      windowSeconds: 300,
      maxAutoExtensions: 8,
      minUndercut: '0.01',
      tenderRef: tender.id,
    });
    createdAuctionIds.push(auction.id);

    const res = await get('/api/tenders/history', adminToken);
    expect(res.status).toBe(200);
    const entry = res.body.tenders.find((t: { id: number }) => t.id === tender.id);
    expect(entry.auction).toMatchObject({ id: auction.id, status: 'live', winner: null });
  });
});
