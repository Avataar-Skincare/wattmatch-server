import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import express from 'express';
import { generateVettingKeypair, sealPayload } from '../lib/vettingCrypto.js';
import { VettingBid } from '../models/VettingBid.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { TenderDocumentField } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { signOrgToken } from '../lib/orgAuth.js';

// Ceremony coverage (custodian share submission, key reconstruction, envelope opening) lives in
// vettingCustodian.test.ts now — routes/vettingBids.ts no longer runs ceremonies itself (see
// routes/vettingCustodian.ts). This file covers submission (including the new bidSubmissionDeadline
// gate), technical-decision, decided-record, the opened-content view, and public-keys — everything
// that's still actually in vettingBids.ts.

async function cleanupTender(tenderRef: string) {
  const bids = await VettingBid.findAll({ where: { tenderRef } });
  for (const bid of bids) {
    await VettingDecidedRecord.destroy({ where: { vettingBidId: bid.id } });
  }
  await VettingBid.destroy({ where: { tenderRef } });
  await VettingOpeningAttestation.destroy({ where: { tenderRef } });
  await TenderInvitation.destroy({ where: { tenderId: Number(tenderRef) } });
  await Payment.destroy({ where: { tenderId: Number(tenderRef) } });
  await EmdSubmission.destroy({ where: { tenderId: Number(tenderRef) } });
  await TenderDocumentUpload.destroy({ where: { tenderId: Number(tenderRef) } });
  await TenderDocumentField.destroy({ where: { tenderId: Number(tenderRef) } });
  await Tender.destroy({ where: { id: Number(tenderRef) } });
}

let app: express.Express;
let technicalKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
let financialKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
let buyerOrgId: number;
let generatorOrgId: number;
let generatorEmail: string;
let adminOrgId: number;
let generatorToken: string;
let adminToken: string;

beforeAll(async () => {
  technicalKey = await generateVettingKeypair();
  financialKey = await generateVettingKeypair();
  process.env.VETTING_TECHNICAL_PUBLIC_KEY_PEM = technicalKey.publicKeyPem;
  process.env.VETTING_TECHNICAL_PUBLIC_KEY_FINGERPRINT = technicalKey.fingerprint;
  process.env.VETTING_FINANCIAL_PUBLIC_KEY_PEM = financialKey.publicKeyPem;
  process.env.VETTING_FINANCIAL_PUBLIC_KEY_FINGERPRINT = financialKey.fingerprint;

  const { default: vettingBidsRouter } = await import('./vettingBids.js');
  app = express();
  app.use(express.json());
  app.use('/api', vettingBidsRouter);

  // Submission is gated on a real generator org + accepted invitation (see vettingBids.ts) — one
  // shared buyer/generator/admin trio for the whole file, a fresh Tender+Invitation per test below.
  const buyer = await Organization.create({ type: 'buyer', name: 'Test Buyer Co', contactEmail: `buyer-${Date.now()}@test.local`, contactPhone: '9000000000' });
  const generator = await Organization.create({ type: 'generator', name: 'GEN-A', contactEmail: `gen-${Date.now()}@test.local`, contactPhone: '9000000001' });
  const admin = await Organization.create({ type: 'admin', name: 'Test Admin', contactEmail: `admin-${Date.now()}@test.local`, contactPhone: '9000000002' });
  buyerOrgId = buyer.id;
  generatorOrgId = generator.id;
  generatorEmail = generator.contactEmail;
  adminOrgId = admin.id;
  generatorToken = await signOrgToken({ organizationId: generator.id, type: 'generator' });
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
});

afterAll(async () => {
  await Organization.destroy({ where: { id: [buyerOrgId, generatorOrgId, adminOrgId] } });
});

// Creates a real Tender + an 'accepted' invitation for the shared test generator, and returns its
// id (as a string) to use as tenderRef. Also pre-satisfies the RfS Document fee, Bid Processing Fee,
// and EMD gates, since submission is gated on all three (see vettingBids.ts's missingFees check) —
// most tests here are about submission/decision mechanics, not the gates themselves, so satisfying
// them up front keeps tests focused on what they're testing.
// bidSubmissionDeadline left null (not required at the model level, only at the HTTP creation
// route) — deadline enforcement gets its own dedicated test below with an explicit deadline set.
async function makeInvitedTender(): Promise<string> {
  const tender = await Tender.create({ buyerOrgId, title: `Test tender ${Date.now()}-${Math.random().toString(36).slice(2)}`, requiredCapacityMw: '1' });
  await TenderInvitation.create({ tenderId: tender.id, organizationId: generatorOrgId, status: 'accepted' });
  await payRfsDocumentFee(tender.id);
  await payBidProcessingFee(tender.id);
  await submitEmd(tender.id);
  return String(tender.id);
}

// organizationId: null + payerEmail, same account-less shape a real RfS Document purchase leaves
// behind (see rfsDocumentAccessService.ts / payments.ts).
async function payRfsDocumentFee(tenderId: number): Promise<void> {
  await Payment.create({
    purpose: 'rfs_document',
    tenderId,
    organizationId: null,
    payerEmail: generatorEmail,
    razorpayOrderId: `order_TEST_rfs_document_${tenderId}_${Math.random().toString(36).slice(2)}`,
    amountPaise: 100,
    currency: 'INR',
    status: 'paid',
  });
}

async function payBidProcessingFee(tenderId: number): Promise<void> {
  await Payment.create({
    purpose: 'bid_processing',
    tenderId,
    organizationId: generatorOrgId,
    razorpayOrderId: `order_TEST_bid_processing_${tenderId}_${Math.random().toString(36).slice(2)}`,
    amountPaise: 100,
    currency: 'INR',
    status: 'paid',
  });
}

// EMD is a document now (see EmdSubmission), not a Payment — creating the row directly here mirrors
// what the real emdSubmissions.ts upload route leaves behind, without adding a real S3 dependency
// to this test file (emdSubmissions.test.ts covers the actual upload route).
async function submitEmd(tenderId: number): Promise<void> {
  await EmdSubmission.create({
    tenderId,
    organizationId: generatorOrgId,
    bankName: 'Test Bank',
    guaranteeNumber: `BG-${tenderId}`,
    amountPaise: 100,
    validUpto: '2027-01-01',
    documentS3Key: `test/${tenderId}/bg.pdf`,
    documentOriginalFilename: 'bg.pdf',
    returnRecipientName: 'GEN-A',
    returnAddressLine: '1 Test Street',
    returnCity: 'Delhi',
    returnState: 'Delhi',
    returnPincode: '110021',
    returnPhone: '9000000001',
  });
}

function submitBid(tenderRef: string, technicalContent: string, financialContent: string) {
  return {
    tenderRef,
    technical: sealPayload(technicalKey.publicKeyPem, technicalContent),
    financial: sealPayload(financialKey.publicKeyPem, financialContent),
  };
}

async function post(path: string, body: unknown, token?: string) {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
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

describe('vettingBids routes', () => {
  let tenderRef: string;

  afterEach(async () => {
    if (tenderRef) await cleanupTender(tenderRef);
  });

  it('submits a bid and returns a receipt with ciphertext hashes', async () => {
    tenderRef = await makeInvitedTender();
    const res = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.receipt.technicalCiphertextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects submission with a missing tenderRef', async () => {
    tenderRef = await makeInvitedTender();
    const body = submitBid(tenderRef, '{}', '{}') as Record<string, unknown>;
    delete body.tenderRef;
    const res = await post('/api/vetting-bids', body, generatorToken);
    expect(res.status).toBe(400);
  });

  it('rejects submission without a valid generator token', async () => {
    tenderRef = await makeInvitedTender();
    const res = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'));
    expect(res.status).toBe(401);
  });

  it('rejects submission after the tender\'s bidSubmissionDeadline has passed', async () => {
    const tender = await Tender.create({
      buyerOrgId,
      title: `Past deadline ${Date.now()}`,
      requiredCapacityMw: '1',
      bidSubmissionDeadline: new Date(Date.now() - 60 * 1000), // one minute ago
    });
    tenderRef = String(tender.id);
    await TenderInvitation.create({ tenderId: tender.id, organizationId: generatorOrgId, status: 'accepted' });
    await payBidProcessingFee(tender.id);
    await submitEmd(tender.id);

    const res = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(res.status).toBe(409);
  });

  it('rejects submission when no accepted invitation exists for this tender', async () => {
    const tender = await Tender.create({ buyerOrgId, title: `No invite ${Date.now()}`, requiredCapacityMw: '1' });
    tenderRef = String(tender.id);
    const res = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(res.status).toBe(403);
  });

  it('rejects submission when the Bid Processing Fee is unpaid', async () => {
    const tender = await Tender.create({ buyerOrgId, title: `Unpaid fee ${Date.now()}`, requiredCapacityMw: '1' });
    tenderRef = String(tender.id);
    await TenderInvitation.create({ tenderId: tender.id, organizationId: generatorOrgId, status: 'accepted' });
    await payRfsDocumentFee(tender.id);
    await submitEmd(tender.id);
    // Deliberately no payBidProcessingFee() call — invited, accepted, RfS fee paid, and EMD
    // submitted, but the Bid Processing Fee unpaid.

    const feeMissing = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(feeMissing.status).toBe(402);
    expect(feeMissing.body.missingFees).toEqual(['Bid Processing Fee']);

    await payBidProcessingFee(tender.id);
    const feePaid = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(feePaid.status).toBe(200);
  });

  it('rejects submission when the EMD Bank Guarantee has not been submitted', async () => {
    const tender = await Tender.create({ buyerOrgId, title: `No EMD ${Date.now()}`, requiredCapacityMw: '1' });
    tenderRef = String(tender.id);
    await TenderInvitation.create({ tenderId: tender.id, organizationId: generatorOrgId, status: 'accepted' });
    await payRfsDocumentFee(tender.id);
    await payBidProcessingFee(tender.id);
    // Deliberately no submitEmd() call — both fees paid, but no Bank Guarantee on file.

    const emdMissing = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(emdMissing.status).toBe(400);

    await submitEmd(tender.id);
    const emdSubmitted = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(emdSubmitted.status).toBe(200);
  });

  it('rejects submission when required documents are missing, and names exactly which are missing', async () => {
    const tender = await Tender.create({ buyerOrgId, title: `Missing docs ${Date.now()}`, requiredCapacityMw: '1' });
    tenderRef = String(tender.id);
    await TenderInvitation.create({ tenderId: tender.id, organizationId: generatorOrgId, status: 'accepted' });
    await payRfsDocumentFee(tender.id);
    await payBidProcessingFee(tender.id);
    await submitEmd(tender.id);

    // Two required fields, one optional — created directly (not via POST /tenders, so the default
    // checklist isn't seeded) to keep this test's assertions short and specific.
    const fieldA = await TenderDocumentField.create({ tenderId: tender.id, envelope: 'technical', key: 'field_a', label: 'Field A', required: true, sortOrder: 0 });
    const fieldB = await TenderDocumentField.create({ tenderId: tender.id, envelope: 'technical', key: 'field_b', label: 'Field B', required: true, sortOrder: 1 });
    await TenderDocumentField.create({ tenderId: tender.id, envelope: 'financial', key: 'field_c', label: 'Field C (optional)', required: false, sortOrder: 2 });

    const noneUploaded = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(noneUploaded.status).toBe(400);
    expect(noneUploaded.body.missingDocuments).toEqual(['Field A', 'Field B']);

    await TenderDocumentUpload.create({ tenderId: tender.id, organizationId: generatorOrgId, fieldId: fieldA.id, s3Key: 'test/a.pdf', originalFilename: 'a.pdf', sizeBytes: 1 });
    const oneUploaded = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(oneUploaded.status).toBe(400);
    expect(oneUploaded.body.missingDocuments).toEqual(['Field B']);

    await TenderDocumentUpload.create({ tenderId: tender.id, organizationId: generatorOrgId, fieldId: fieldB.id, s3Key: 'test/b.pdf', originalFilename: 'b.pdf', sizeBytes: 1 });
    const bothUploaded = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    expect(bothUploaded.status).toBe(200); // optional Field C never uploaded, and correctly never required
  });

  it('records a technical decision only once a technical ceremony attestation exists, and rejects for an unknown bid', async () => {
    tenderRef = await makeInvitedTender();
    const submitRes = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    const bidId = submitRes.body.id;

    const decisionTooEarly = await post(`/api/vetting-bids/${bidId}/technical-decision`, {
      decision: 'approved',
      reviewedContent: '{"capacity":"5MW"}',
    }, adminToken);
    expect(decisionTooEarly.status).toBe(409);

    // Simulates what a completed custodian ceremony leaves behind (routes/vettingCustodian.ts) —
    // the attestation row itself, without running a real ceremony (covered in
    // vettingCustodian.test.ts), since technical-decision only ever checks for its existence.
    await VettingOpeningAttestation.create({
      tenderRef,
      envelope: 'technical',
      openedSetHash: 'test-hash',
      shareFingerprint1: 'fp1',
      shareFingerprint2: 'fp2',
    });

    const unknownBid = await post(`/api/vetting-bids/999999999/technical-decision`, {
      decision: 'approved',
      reviewedContent: '{"capacity":"5MW"}',
    }, adminToken);
    expect(unknownBid.status).toBe(404);

    const decisionRes = await post(`/api/vetting-bids/${bidId}/technical-decision`, {
      decision: 'approved',
      reviewedContent: '{"capacity":"5MW"}',
    }, adminToken);
    expect(decisionRes.status).toBe(200);
    expect(decisionRes.body.technicalStatus).toBe('approved');

    const records = await VettingDecidedRecord.findAll({ where: { vettingBidId: bidId } });
    expect(records.map((r) => r.envelope)).toEqual(['technical']);
  });

  it('lists what a custodian ceremony has opened, admin-only', async () => {
    tenderRef = await makeInvitedTender();
    const submitRes = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);
    const bidId = submitRes.body.id;

    const beforeOpen = await get(`/api/vetting-bids/${tenderRef}/opened/technical`, adminToken);
    expect(beforeOpen.status).toBe(200);
    expect(beforeOpen.body.opened).toEqual([]);

    // Simulates what routes/vettingCustodian.ts's POST /ceremony/complete leaves behind.
    const bid = await VettingBid.findByPk(bidId);
    const { encryptField } = await import('../lib/fieldEncryption.js');
    await bid!.update({ technicalOpenedContent: await encryptField('{"capacity":"5MW"}') });

    const afterOpen = await get(`/api/vetting-bids/${tenderRef}/opened/technical`, adminToken);
    expect(afterOpen.status).toBe(200);
    expect(afterOpen.body.opened).toHaveLength(1);
    expect(afterOpen.body.opened[0].content).toBe('{"capacity":"5MW"}');

    const asGenerator = await get(`/api/vetting-bids/${tenderRef}/opened/technical`, generatorToken);
    expect(asGenerator.status).toBe(403);
  });

  it('lists hasOpenedTechnicalContent/hasOpenedFinancialContent per bid', async () => {
    tenderRef = await makeInvitedTender();
    const submitRes = await post('/api/vetting-bids', submitBid(tenderRef, '{"capacity":"5MW"}', '{"tariff":6.2}'), generatorToken);

    const beforeOpen = await get(`/api/vetting-bids?tenderRef=${tenderRef}`, adminToken);
    expect(beforeOpen.status).toBe(200);
    expect(beforeOpen.body.bids[0].hasOpenedTechnicalContent).toBe(false);
    expect(beforeOpen.body.bids[0].hasOpenedFinancialContent).toBe(false);

    const bid = await VettingBid.findByPk(submitRes.body.id);
    const { encryptField } = await import('../lib/fieldEncryption.js');
    await bid!.update({ technicalOpenedContent: await encryptField('{"capacity":"5MW"}') });

    const afterOpen = await get(`/api/vetting-bids?tenderRef=${tenderRef}`, adminToken);
    expect(afterOpen.body.bids[0].hasOpenedTechnicalContent).toBe(true);
    expect(afterOpen.body.bids[0].hasOpenedFinancialContent).toBe(false);
  });

  it('exposes both public keys and fingerprints to any authenticated org', async () => {
    const anonymous = await get('/api/vetting-bids/public-keys');
    expect(anonymous.status).toBe(401);

    const res = await get('/api/vetting-bids/public-keys', generatorToken);
    expect(res.status).toBe(200);
    expect(res.body.technical.fingerprint).toBe(technicalKey.fingerprint);
    expect(res.body.financial.fingerprint).toBe(financialKey.fingerprint);
  });
});
