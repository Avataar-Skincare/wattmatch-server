import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import { generateVettingKeypair, sealPayload, reconstructPrivateKey, openEnvelope, type SealedEnvelope } from '../lib/vettingCrypto.js';
import { VettingBid } from '../models/VettingBid.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { VettingCustodian } from '../models/VettingCustodian.js';
import { VettingCustodianToken } from '../models/VettingCustodianToken.js';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { signOrgToken } from '../lib/orgAuth.js';
import { generateOpaqueToken } from '../lib/passwordAuth.js';

let app: express.Express;
let technicalKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
let financialKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
let buyerOrgId: number;
let generatorOrgId: number;
let generatorToken: string;
let custodianAId: number;
let custodianBId: number;

const createdTenderIds: number[] = [];

beforeAll(async () => {
  technicalKey = await generateVettingKeypair();
  financialKey = await generateVettingKeypair();
  process.env.VETTING_TECHNICAL_PUBLIC_KEY_PEM = technicalKey.publicKeyPem;
  process.env.VETTING_TECHNICAL_PUBLIC_KEY_FINGERPRINT = technicalKey.fingerprint;
  process.env.VETTING_FINANCIAL_PUBLIC_KEY_PEM = financialKey.publicKeyPem;
  process.env.VETTING_FINANCIAL_PUBLIC_KEY_FINGERPRINT = financialKey.fingerprint;

  const { default: vettingCustodianRouter } = await import('./vettingCustodian.js');
  app = express();
  app.use(express.json());
  app.use('/api', vettingCustodianRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  const buyer = await Organization.create({ type: 'buyer', name: 'Custodian Test Buyer', contactEmail: `custodian-buyer-${Date.now()}@test.local`, contactPhone: '9000000010' });
  const generator = await Organization.create({ type: 'generator', name: 'Custodian Test Gen', contactEmail: `custodian-gen-${Date.now()}@test.local`, contactPhone: '9000000011' });
  buyerOrgId = buyer.id;
  generatorOrgId = generator.id;
  generatorToken = await signOrgToken({ organizationId: generator.id, type: 'generator' });

  const custodianA = await VettingCustodian.create({ name: 'Custodian A', email: `custodian-a-${Date.now()}@test.local` });
  const custodianB = await VettingCustodian.create({ name: 'Custodian B', email: `custodian-b-${Date.now()}@test.local` });
  custodianAId = custodianA.id;
  custodianBId = custodianB.id;
});

afterAll(async () => {
  await VettingCustodianToken.destroy({ where: { custodianId: [custodianAId, custodianBId] } });
  await VettingCustodian.destroy({ where: { id: [custodianAId, custodianBId] } });
  for (const id of createdTenderIds) {
    const bids = await VettingBid.findAll({ where: { tenderRef: String(id) } });
    for (const bid of bids) await VettingDecidedRecord.destroy({ where: { vettingBidId: bid.id } });
    await VettingBid.destroy({ where: { tenderRef: String(id) } });
    await VettingOpeningAttestation.destroy({ where: { tenderRef: String(id) } });
    await TenderInvitation.destroy({ where: { tenderId: id } });
    await Payment.destroy({ where: { tenderId: id } });
    await EmdSubmission.destroy({ where: { tenderId: id } });
    await Tender.destroy({ where: { id } });
  }
  await Organization.destroy({ where: { id: [buyerOrgId, generatorOrgId] } });
});

// A tender with real, already-past technicalBidOpenAt/financialBidOpenAt (so ceremony routes are
// immediately callable in tests) plus one submitted bid, ready to open.
async function makeTenderWithSubmittedBid(): Promise<number> {
  const tender = await Tender.create({
    buyerOrgId,
    title: `Custodian test tender ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    requiredCapacityMw: '1',
    technicalBidOpenAt: new Date(Date.now() - 60 * 1000),
    financialBidOpenAt: new Date(Date.now() - 30 * 1000),
  });
  createdTenderIds.push(tender.id);
  await TenderInvitation.create({ tenderId: tender.id, organizationId: generatorOrgId, status: 'accepted' });
  await Payment.create({
    purpose: 'bid_processing',
    tenderId: tender.id,
    organizationId: generatorOrgId,
    razorpayOrderId: `order_TEST_${tender.id}_${Math.random().toString(36).slice(2)}`,
    amountPaise: 100,
    currency: 'INR',
    status: 'paid',
  });
  await EmdSubmission.create({
    tenderId: tender.id,
    organizationId: generatorOrgId,
    bankName: 'Test Bank',
    guaranteeNumber: `BG-${tender.id}`,
    amountPaise: 100,
    validUpto: '2027-01-01',
    documentS3Key: `test/${tender.id}/bg.pdf`,
    documentOriginalFilename: 'bg.pdf',
    returnRecipientName: 'Custodian Test Gen',
    returnAddressLine: '1 Test Street',
    returnCity: 'Delhi',
    returnState: 'Delhi',
    returnPincode: '110021',
    returnPhone: '9000000011',
  });

  const bid = await VettingBid.create({
    tenderRef: String(tender.id),
    applicantAlias: 'Custodian Test Gen',
    generatorOrgId,
    technicalWrappedKey: '', technicalIv: '', technicalCiphertext: '', technicalCiphertextHash: '',
    financialWrappedKey: '', financialIv: '', financialCiphertext: '', financialCiphertextHash: '',
  });
  const technical = sealPayload(technicalKey.publicKeyPem, JSON.stringify({ capacity: '5MW' }));
  const financial = sealPayload(financialKey.publicKeyPem, JSON.stringify({ tariff: 6.2 }));
  await bid.update({
    technicalWrappedKey: technical.wrappedDataKey, technicalIv: technical.iv, technicalCiphertext: technical.ciphertext,
    technicalCiphertextHash: crypto.createHash('sha256').update(technical.ciphertext).digest('hex'),
    financialWrappedKey: financial.wrappedDataKey, financialIv: financial.iv, financialCiphertext: financial.ciphertext,
    financialCiphertextHash: crypto.createHash('sha256').update(financial.ciphertext).digest('hex'),
  });

  return tender.id;
}

async function issueToken(custodianId: number, tenderId: number, envelope: 'technical' | 'financial'): Promise<string> {
  const { token, tokenHash } = generateOpaqueToken();
  await VettingCustodianToken.create({ custodianId, tenderId, envelope, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  return token;
}

async function post(path: string, body: unknown, token?: string) {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

async function get(path: string, token?: string) {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('POST /vetting-custodian/ceremony/share', () => {
  it('rejects with no token', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const res = await post('/api/vetting-custodian/ceremony/share', { share: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const res = await post('/api/vetting-custodian/ceremony/share', { share: 'x' }, 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects before the tender\'s scheduled open date', async () => {
    const tender = await Tender.create({
      buyerOrgId,
      title: `Not yet open ${Date.now()}`,
      requiredCapacityMw: '1',
      technicalBidOpenAt: new Date(Date.now() + 60 * 60 * 1000), // an hour from now
    });
    createdTenderIds.push(tender.id);
    const token = await issueToken(custodianAId, tender.id, 'technical');

    const res = await post('/api/vetting-custodian/ceremony/share', { share: 'x' }, token);
    expect(res.status).toBe(409);
  });

  it('escrows the first share, then hands both back to a second, different custodian', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const tokenA = await issueToken(custodianAId, tenderId, 'technical');
    const tokenB = await issueToken(custodianBId, tenderId, 'technical');

    const first = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[0]).toString('base64') }, tokenA);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('waiting');

    const second = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[1]).toString('base64') }, tokenB);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('ready');
    expect(second.body.otherShare).toBe(Buffer.from(technicalKey.shares[0]).toString('base64'));
  });

  it('rejects the same custodian submitting twice for one ceremony', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    // Same token reused for both attempts — the token itself is multi-use (see
    // VettingCustodianToken's own comment), so what must reject the second attempt is the ceremony
    // state (this custodian already has an escrowed share), not a fresh/second token.
    const tokenA = await issueToken(custodianAId, tenderId, 'technical');
    const first = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[0]).toString('base64') }, tokenA);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('waiting');

    const second = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[1]).toString('base64') }, tokenA);
    expect(second.status).toBe(409);
  });

  it('rejects opening the financial envelope before any technical decision exists', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const token = await issueToken(custodianAId, tenderId, 'financial');
    const res = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(financialKey.shares[0]).toString('base64') }, token);
    expect(res.status).toBe(409);
  });

  // Regression coverage for the escrow-recovery fix: previously the escrow was deleted the instant
  // the second custodian retrieved it, so a browser failure between here and /ceremony/complete
  // silently destroyed both custodians' progress. Now the escrow survives until completion actually
  // succeeds, so the same second custodian can safely retry this exact call.
  it('lets the second custodian re-request the pairing after an earlier failure, without the first custodian resubmitting', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const tokenA = await issueToken(custodianAId, tenderId, 'technical');
    const tokenB = await issueToken(custodianBId, tenderId, 'technical');

    await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[0]).toString('base64') }, tokenA);
    const first = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[1]).toString('base64') }, tokenB);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ready');

    // Simulates B's browser failing before /ceremony/complete ever runs — B reloads and resubmits.
    const retry = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[1]).toString('base64') }, tokenB);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('ready');
    expect(retry.body.otherShare).toBe(first.body.otherShare); // A's original share is still intact

    // A never needs to do anything — their status still just says "waiting."
    const statusForA = await get('/api/vetting-custodian/ceremony', tokenA);
    expect(statusForA.body.youAlreadySubmitted).toBe(true);

    // B's own status still shows them free to (re)submit, not stuck on a dead "waiting" page.
    const statusForB = await get('/api/vetting-custodian/ceremony', tokenB);
    expect(statusForB.body.youAlreadySubmitted).toBe(false);
  });

  it('rejects a third, different custodian trying to join a pairing already claimed by a second', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const tokenA = await issueToken(custodianAId, tenderId, 'technical');
    const tokenB = await issueToken(custodianBId, tenderId, 'technical');
    const thirdCustodian = await VettingCustodian.create({ name: 'Custodian C', email: `custodian-c-${Date.now()}@test.local` });
    const tokenC = await issueToken(thirdCustodian.id, tenderId, 'technical');

    await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[0]).toString('base64') }, tokenA);
    await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[1]).toString('base64') }, tokenB);

    const thirdAttempt = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[2]).toString('base64') }, tokenC);
    expect(thirdAttempt.status).toBe(409);

    await VettingCustodianToken.destroy({ where: { custodianId: thirdCustodian.id } });
    await VettingCustodian.destroy({ where: { id: thirdCustodian.id } });
  });
});

describe('full ceremony: share -> sealed-envelopes -> complete', () => {
  it('opens the technical envelope end to end and records an attestation', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const tokenA = await issueToken(custodianAId, tenderId, 'technical');
    const tokenB = await issueToken(custodianBId, tenderId, 'technical');

    await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[0]).toString('base64') }, tokenA);
    const shareRes = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[1]).toString('base64') }, tokenB);
    const otherShare = shareRes.body.otherShare;

    const envelopesRes = await get('/api/vetting-custodian/ceremony/sealed-envelopes', tokenB);
    expect(envelopesRes.status).toBe(200);
    expect(envelopesRes.body.envelopes).toHaveLength(1);

    const privateKey = await reconstructPrivateKey(
      [new Uint8Array(Buffer.from(otherShare, 'base64')), technicalKey.shares[1]],
      technicalKey.fingerprint
    );
    const opened = envelopesRes.body.envelopes.map((e: { id: number; wrappedDataKey: string; iv: string; ciphertext: string }) => ({
      bidId: e.id,
      content: openEnvelope(privateKey, { wrappedDataKey: e.wrappedDataKey, iv: e.iv, ciphertext: e.ciphertext } as SealedEnvelope),
    }));
    expect(JSON.parse(opened[0].content)).toEqual({ capacity: '5MW' });

    const completeRes = await post('/api/vetting-custodian/ceremony/complete', {
      openedBidIds: opened.map((o: { bidId: number }) => o.bidId),
      opened,
      shareFingerprints: ['fp1', 'fp2'],
    }, tokenB);
    expect(completeRes.status).toBe(200);

    const attestation = await VettingOpeningAttestation.findOne({ where: { tenderRef: String(tenderId), envelope: 'technical' } });
    expect(attestation).not.toBeNull();

    const bid = await VettingBid.findOne({ where: { tenderRef: String(tenderId) } });
    expect(bid!.technicalOpenedContent).not.toBeNull();

    // A completed ceremony can't be re-run.
    const rerun = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[2]).toString('base64') }, tokenA);
    expect(rerun.status).toBe(409);
  });

  it('rejects a completion whose claimed opened-bid set does not match what is actually pending', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const tokenB = await issueToken(custodianBId, tenderId, 'technical');

    const res = await post('/api/vetting-custodian/ceremony/complete', {
      openedBidIds: [999999999],
      opened: [{ bidId: 999999999, content: 'fabricated' }],
      shareFingerprints: ['fp1', 'fp2'],
    }, tokenB);
    expect(res.status).toBe(409);
  });

  it('opening the financial envelope writes a VettingDecidedRecord directly, not just the staging column', async () => {
    const tenderId = await makeTenderWithSubmittedBid();

    // Financial can only open once a technical decision exists — approve the bid directly (the
    // decision route itself is covered in vettingBids.test.ts).
    const bid = await VettingBid.findOne({ where: { tenderRef: String(tenderId) } });
    await bid!.update({ technicalStatus: 'approved' });

    const tokenA = await issueToken(custodianAId, tenderId, 'financial');
    const tokenB = await issueToken(custodianBId, tenderId, 'financial');
    await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(financialKey.shares[0]).toString('base64') }, tokenA);
    const shareRes = await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(financialKey.shares[1]).toString('base64') }, tokenB);

    const envelopesRes = await get('/api/vetting-custodian/ceremony/sealed-envelopes', tokenB);
    const privateKey = await reconstructPrivateKey(
      [new Uint8Array(Buffer.from(shareRes.body.otherShare, 'base64')), financialKey.shares[1]],
      financialKey.fingerprint
    );
    const opened = envelopesRes.body.envelopes.map((e: { id: number; wrappedDataKey: string; iv: string; ciphertext: string }) => ({
      bidId: e.id,
      content: openEnvelope(privateKey, { wrappedDataKey: e.wrappedDataKey, iv: e.iv, ciphertext: e.ciphertext } as SealedEnvelope),
    }));

    await post('/api/vetting-custodian/ceremony/complete', {
      openedBidIds: opened.map((o: { bidId: number }) => o.bidId),
      opened,
      shareFingerprints: ['fp1', 'fp2'],
    }, tokenB);

    const record = await VettingDecidedRecord.findOne({ where: { vettingBidId: bid!.id, envelope: 'financial' } });
    expect(record).not.toBeNull();
  });
});

describe('GET /vetting-custodian/ceremony', () => {
  it('reports status without requiring the completing step', async () => {
    const tenderId = await makeTenderWithSubmittedBid();
    const tokenA = await issueToken(custodianAId, tenderId, 'technical');

    const before = await get('/api/vetting-custodian/ceremony', tokenA);
    expect(before.status).toBe(200);
    expect(before.body.alreadyCompleted).toBe(false);
    expect(before.body.awaitingSecondCustodian).toBe(false);
    expect(before.body.pendingCount).toBe(1);

    await post('/api/vetting-custodian/ceremony/share', { share: Buffer.from(technicalKey.shares[0]).toString('base64') }, tokenA);

    const tokenB = await issueToken(custodianBId, tenderId, 'technical');
    const afterFirstShare = await get('/api/vetting-custodian/ceremony', tokenB);
    expect(afterFirstShare.body.awaitingSecondCustodian).toBe(true);
  });
});
