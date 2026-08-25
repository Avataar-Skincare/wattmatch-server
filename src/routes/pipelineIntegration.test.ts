import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { generateVettingKeypair, sealPayload } from '../lib/vettingCrypto.js';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { VettingBid } from '../models/VettingBid.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { TenderDocumentField } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { TenderRequest } from '../models/TenderRequest.js';
import { signOrgToken } from '../lib/orgAuth.js';

// Proves the full minimal pipeline actually connects end to end — see
// MINIMAL_PIPELINE_INTEGRATION_PLAN.md and VETTING_TO_AUCTION_BRIDGE_PLAN.md. Real MySQL/Redis,
// not mocks, same isolation approach as the rest of this test suite (unique ids, explicit cleanup).

let app: express.Express;
let technicalKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
let financialKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
const createdOrgIds: number[] = [];
const createdTenderIds: number[] = [];
const createdAuctionIds: number[] = [];

beforeAll(async () => {
  technicalKey = await generateVettingKeypair();
  financialKey = await generateVettingKeypair();
  process.env.VETTING_TECHNICAL_PUBLIC_KEY_PEM = technicalKey.publicKeyPem;
  process.env.VETTING_TECHNICAL_PUBLIC_KEY_FINGERPRINT = technicalKey.fingerprint;
  process.env.VETTING_FINANCIAL_PUBLIC_KEY_PEM = financialKey.publicKeyPem;
  process.env.VETTING_FINANCIAL_PUBLIC_KEY_FINGERPRINT = financialKey.fingerprint;

  const { default: organizationsRouter } = await import('./organizations.js');
  const { default: tendersRouter } = await import('./tenders.js');
  const { default: vettingBidsRouter } = await import('./vettingBids.js');
  const { default: vettingAuctionBridgeRouter } = await import('./vettingAuctionBridge.js');

  app = express();
  app.use(express.json());
  app.use('/api', organizationsRouter);
  app.use('/api', tendersRouter);
  app.use('/api', vettingBidsRouter);
  app.use('/api', vettingAuctionBridgeRouter);
});

afterAll(async () => {
  for (const id of createdAuctionIds) {
    await AuctionParticipant.destroy({ where: { auctionId: id } });
    await Auction.destroy({ where: { id } });
  }
  for (const id of createdTenderIds) {
    const bids = await VettingBid.findAll({ where: { tenderRef: String(id) } });
    for (const bid of bids) await VettingDecidedRecord.destroy({ where: { vettingBidId: bid.id } });
    await VettingBid.destroy({ where: { tenderRef: String(id) } });
    await VettingOpeningAttestation.destroy({ where: { tenderRef: String(id) } });
    await TenderInvitation.destroy({ where: { tenderId: id } });
    await Payment.destroy({ where: { tenderId: id } });
    await EmdSubmission.destroy({ where: { tenderId: id } });
    await TenderDocumentUpload.destroy({ where: { tenderId: id } });
    await TenderDocumentField.destroy({ where: { tenderId: id } });
    await TenderRequest.destroy({ where: { tenderId: id } });
    await Tender.destroy({ where: { id } });
  }
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
});

async function request(method: 'GET' | 'POST', path: string, body?: unknown, token?: string) {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('full minimal pipeline: registration -> tender -> matching -> vetting -> auction', () => {
  it('connects every stage end to end', async () => {
    // 1. Register a buyer and a generator.
    const buyerReg = await request('POST', '/api/organizations', {
      type: 'buyer',
      name: 'Test Buyer Co',
      contactEmail: 'buyer@example.com',
      contactPhone: '9999999999',
      password: 'correct-horse-battery',
    });
    expect(buyerReg.status).toBe(200);
    createdOrgIds.push(buyerReg.body.organizationId);

    const generatorReg = await request('POST', '/api/organizations', {
      type: 'generator',
      name: 'Test Generator Co',
      contactEmail: 'gen@example.com',
      contactPhone: '8888888888',
      password: 'correct-horse-battery',
      capacityMw: 8,
    });
    expect(generatorReg.status).toBe(200);
    createdOrgIds.push(generatorReg.body.organizationId);

    // 2. Buyer submits a tender REQUEST (not a live tender directly) — an internal admin reviews
    // it and creates the real, priced tender. Admin org created directly via the model since the
    // public registration route deliberately doesn't allow self-registering as 'admin'.
    const adminOrg = await Organization.create({
      type: 'admin',
      name: 'Test Admin',
      contactEmail: `admin-${Date.now()}@test.local`,
      contactPhone: '7000000000',
    });
    createdOrgIds.push(adminOrg.id);
    const adminToken = await signOrgToken({ organizationId: adminOrg.id, type: 'admin' });

    const requestRes = await request(
      'POST',
      '/api/tender-requests',
      { title: 'Pipeline integration test tender', requiredCapacityMw: 5 },
      buyerReg.body.token
    );
    expect(requestRes.status).toBe(200);
    const tenderRequestId = requestRes.body.id;

    // A buyer cannot create a tender directly any more — only an admin can.
    const wrongRoleRes = await request(
      'POST',
      '/api/tenders',
      { title: 'Should fail', requiredCapacityMw: 1, buyerOrgId: buyerReg.body.organizationId, rfsDocumentFeePaise: 100, bidProcessingFeePaise: 100, emdAmountPaise: 100 },
      buyerReg.body.token
    );
    expect(wrongRoleRes.status).toBe(403);

    // Admin converts the request into a real tender with its own per-tender pricing — matching +
    // invitation is automatic at creation (no buyer curation step), so the already-registered,
    // capacity-matching generator is auto-invited here.
    const tenderRes = await request(
      'POST',
      '/api/tenders',
      {
        title: 'Pipeline integration test tender',
        requiredCapacityMw: 5,
        tenderRequestId,
        rfsDocumentFeePaise: 100,
        bidProcessingFeePaise: 100,
        emdAmountPaise: 100,
      },
      adminToken
    );
    expect(tenderRes.status).toBe(200);
    const tenderId = tenderRes.body.tenderId;
    createdTenderIds.push(tenderId);
    expect(tenderRes.body.autoInvitedOrganizationIds).toContain(generatorReg.body.organizationId);

    const convertedRequest = await TenderRequest.findByPk(tenderRequestId);
    expect(convertedRequest!.status).toBe('converted');
    expect(convertedRequest!.tenderId).toBe(tenderId);

    // 3. Matching engine returns the registered generator (capacity-filtered, admin-only view — the
    // buyer has no operational role in running a tender once they've requested it).
    const matchesRes = await request('GET', `/api/tenders/${tenderId}/matches`, undefined, adminToken);
    expect(matchesRes.status).toBe(200);
    expect(matchesRes.body.matches.map((m: { organizationId: number }) => m.organizationId)).toContain(
      generatorReg.body.organizationId
    );

    // 3b. Generator was already auto-invited at tender creation — can now see the tender and accepts.
    const tenderViewRes = await request('GET', `/api/tenders/${tenderId}`, undefined, generatorReg.body.token);
    expect(tenderViewRes.status).toBe(200);
    expect(tenderViewRes.body.invitationStatus).toBe('invited');

    const respondRes = await request(
      'POST',
      `/api/tenders/${tenderId}/invitations/respond`,
      { accept: true },
      generatorReg.body.token
    );
    expect(respondRes.status).toBe(200);
    expect(respondRes.body.status).toBe('accepted');

    // 3c. Pay the Bid Processing Fee — submission is now gated on this (see vettingBids.ts).
    // Creating the Payment row directly here (rather than through the real order+webhook HTTP
    // flow, which needs live Razorpay credentials — see payments.test.ts for that full coverage)
    // mirrors exactly what a captured webhook leaves behind, without adding a new external
    // dependency to this broader pipeline test.
    await Payment.create({
      purpose: 'bid_processing',
      tenderId,
      organizationId: generatorReg.body.organizationId,
      razorpayOrderId: `order_TEST_bid_processing_${tenderId}`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });

    // 3c-ii. Submit the EMD — a document (Bank Guarantee), not a payment, since submission is also
    // gated on this (see vettingBids.ts / EmdSubmission.ts). Creating the row directly here, same
    // reasoning as above: proves the gate is satisfied without adding a real S3 dependency to this
    // broader pipeline test (emdSubmissions.test.ts covers the actual upload route end to end).
    await EmdSubmission.create({
      tenderId,
      organizationId: generatorReg.body.organizationId,
      bankName: 'Test Bank',
      guaranteeNumber: `BG-${tenderId}`,
      amountPaise: 100,
      validUpto: '2027-01-01',
      documentS3Key: `test/${tenderId}/bg.pdf`,
      documentOriginalFilename: 'bg.pdf',
      returnRecipientName: 'Test Generator Co',
      returnAddressLine: '1 Test Street',
      returnCity: 'Delhi',
      returnState: 'Delhi',
      returnPincode: '110021',
      returnPhone: '8888888888',
    });

    // 3d. Satisfy the document checklist gate — posting the tender through the real HTTP route
    // above seeds the full default document-field registry (tenderDocuments.ts), so submission is
    // now also gated on every required field having this generator's upload on file. Creating the
    // TenderDocumentUpload rows directly here, same reasoning as 3c: proves the gate is satisfied
    // without adding a real S3 dependency to this broader pipeline test (tenderDocuments.test.ts
    // covers the actual upload route end to end).
    const requiredFields = await TenderDocumentField.findAll({ where: { tenderId, required: true } });
    await TenderDocumentUpload.bulkCreate(
      requiredFields.map((f) => ({
        tenderId,
        organizationId: generatorReg.body.organizationId,
        fieldId: f.id,
        s3Key: `test/${tenderId}/${f.id}.pdf`,
        originalFilename: 'test.pdf',
        sizeBytes: 1,
      }))
    );

    // 4. Generator submits a sealed technical+financial bid against the real tender id, now that
    // it holds an accepted invitation and has paid the required fees. applicantAlias is derived
    // server-side from the org's own name — no longer client-supplied.
    const submitRes = await request(
      'POST',
      '/api/vetting-bids',
      {
        tenderRef: String(tenderId),
        technical: sealPayload(technicalKey.publicKeyPem, JSON.stringify({ capacity: '5MW' })),
        financial: sealPayload(financialKey.publicKeyPem, JSON.stringify({ tariff: 5.75 })),
      },
      generatorReg.body.token
    );
    expect(submitRes.status).toBe(200);
    const bidId = submitRes.body.id;

    // 5. Admin dashboard: technical ceremony, then decision.
    const openTechnicalRes = await request('POST', '/api/vetting-bids/open-technical', {
      tenderRef: String(tenderId),
      shares: [Buffer.from(technicalKey.shares[0]).toString('base64'), Buffer.from(technicalKey.shares[1]).toString('base64')],
    });
    expect(openTechnicalRes.status).toBe(200);
    expect(JSON.parse(openTechnicalRes.body.opened[0].content)).toEqual({ capacity: '5MW' });

    const decisionRes = await request('POST', `/api/vetting-bids/${bidId}/technical-decision`, {
      decision: 'approved',
      reviewedContent: JSON.stringify({ capacity: '5MW' }),
    });
    expect(decisionRes.status).toBe(200);

    // 6. Financial ceremony opens the approved generator's rate bid.
    const openFinancialRes = await request('POST', '/api/vetting-bids/open-financial', {
      tenderRef: String(tenderId),
      shares: [Buffer.from(financialKey.shares[0]).toString('base64'), Buffer.from(financialKey.shares[2]).toString('base64')],
    });
    expect(openFinancialRes.status).toBe(200);
    expect(openFinancialRes.body.opened).toHaveLength(1);

    // 7. Promote the tender to a live auction — the actual connection point under test.
    const promoteRes = await request('POST', `/api/vetting-bids/${tenderId}/promote-to-auction`, {});
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.links).toHaveLength(1);
    expect(promoteRes.body.links[0].alias).toBe('Test Generator Co');
    createdAuctionIds.push(promoteRes.body.auctionId);

    const auction = await Auction.findByPk(promoteRes.body.auctionId);
    expect(auction).not.toBeNull();
    expect(auction!.status).toBe('live');
    expect(Number(auction!.openingBid)).toBe(5.75); // the only approved generator's tariff
    expect(auction!.tenderRef).toBe(tenderId);

    const participants = await AuctionParticipant.findAll({ where: { auctionId: promoteRes.body.auctionId } });
    expect(participants).toHaveLength(1);
    expect(participants[0].alias).toBe('Test Generator Co');

    // Promoting the same tender twice is rejected, not silently duplicated.
    const secondPromoteRes = await request('POST', `/api/vetting-bids/${tenderId}/promote-to-auction`, {});
    expect(secondPromoteRes.status).toBe(409);

    // 8. EMD is a document now (see EmdSubmission), not money — settling the auction winner is no
    // longer a dedicated route (success charge is dropped, and EMD has no Payment to refund any
    // more). Resolving the winner's EMD is the same generic admin action every other generator's
    // EMD uses — release/invoke via emdSubmissions.ts — exercised end to end in
    // emdSubmissions.test.ts, not duplicated here.
    const emdBefore = await EmdSubmission.findOne({ where: { tenderId, organizationId: generatorReg.body.organizationId } });
    expect(emdBefore!.status).toBe('submitted');
  });
});
