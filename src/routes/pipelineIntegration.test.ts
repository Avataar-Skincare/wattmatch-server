import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import { generateVettingKeypair, sealPayload, reconstructPrivateKey, openEnvelope, type SealedEnvelope } from '../lib/vettingCrypto.js';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { VettingBid } from '../models/VettingBid.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { VettingCustodian } from '../models/VettingCustodian.js';
import { VettingCustodianToken } from '../models/VettingCustodianToken.js';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { TenderDocumentField } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { TenderRequest } from '../models/TenderRequest.js';
import { signOrgToken } from '../lib/orgAuth.js';
import { generateOpaqueToken } from '../lib/passwordAuth.js';

// Proves the full minimal pipeline actually connects end to end — see
// MINIMAL_PIPELINE_INTEGRATION_PLAN.md and VETTING_TO_AUCTION_BRIDGE_PLAN.md. Real MySQL/Redis,
// not mocks, same isolation approach as the rest of this test suite (unique ids, explicit cleanup).

let app: express.Express;
let technicalKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
let financialKey: Awaited<ReturnType<typeof generateVettingKeypair>>;
const createdOrgIds: number[] = [];
const createdTenderIds: number[] = [];
const createdAuctionIds: number[] = [];
const createdCustodianIds: number[] = [];

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
  const { default: vettingCustodianRouter } = await import('./vettingCustodian.js');
  const { default: vettingAuctionBridgeRouter } = await import('./vettingAuctionBridge.js');

  app = express();
  app.use(express.json());
  app.use('/api', organizationsRouter);
  app.use('/api', tendersRouter);
  app.use('/api', vettingBidsRouter);
  app.use('/api', vettingCustodianRouter);
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
    await VettingCustodianToken.destroy({ where: { tenderId: id } });
    await TenderInvitation.destroy({ where: { tenderId: id } });
    await Payment.destroy({ where: { tenderId: id } });
    await EmdSubmission.destroy({ where: { tenderId: id } });
    await TenderDocumentUpload.destroy({ where: { tenderId: id } });
    await TenderDocumentField.destroy({ where: { tenderId: id } });
    await TenderRequest.destroy({ where: { tenderId: id } });
    await Tender.destroy({ where: { id } });
  }
  for (const id of createdCustodianIds) await VettingCustodian.destroy({ where: { id } });
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
  // Longer than the global 15s default for two independent reasons: this test's real SMTP sends
  // (registration/invitation emails) fail slowly against whatever mail credentials this environment
  // has configured, and it now deliberately waits for real wall-clock time to cross the tender's
  // scheduled technicalBidOpenAt/financialBidOpenAt before each custodian ceremony step (see
  // msUntil() below) — up to ~22s of real waiting on top of everything else.
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

    // Ceremony scheduling — set relative to real wall-clock time, not the test's own elapsed time:
    // bidSubmissionDeadline is generous (this test's earlier steps, including tender-creation's
    // auto-invite emails, can genuinely take several seconds against this environment's SMTP
    // config), while technicalBidOpenAt/financialBidOpenAt are computed and explicitly waited for
    // below — see msUntil() — rather than assumed to have already passed by coincidence.
    const bidSubmissionDeadline = new Date(Date.now() + 20000).toISOString();
    const technicalBidOpenAt = new Date(Date.now() + 21000).toISOString();
    const financialBidOpenAt = new Date(Date.now() + 22000).toISOString();
    // +500ms buffer: the tender's own scheduleCustodianNotification timer (routes/tenders.ts) is
    // ALSO set to fire at this exact instant and will mint/rotate a token for these same custodians
    // (see custodianNotificationService.ts's find-or-update). Waiting slightly past the target
    // rather than landing on it avoids a genuine race between that real scheduled write and this
    // test's own token issuance right below — this test isn't exercising the scheduler itself, so
    // letting its side effect settle first (then simply being overwritten by this test's later,
    // authoritative issuance) is simpler than trying to win a timer race.
    function msUntil(iso: string): number {
      return Math.max(0, new Date(iso).getTime() - Date.now()) + 500;
    }

    // A buyer cannot create a tender directly any more — only an admin can.
    const wrongRoleRes = await request(
      'POST',
      '/api/tenders',
      {
        title: 'Should fail',
        requiredCapacityMw: 1,
        buyerOrgId: buyerReg.body.organizationId,
        rfsDocumentFeePaise: 100,
        bidProcessingFeePaise: 100,
        emdAmountPaise: 100,
        bidSubmissionDeadline,
        technicalBidOpenAt,
        financialBidOpenAt,
        useLandedRate: true,
        equityValue: 1000000,
        totalUnitsPerYear: 500000,
      },
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
        bidSubmissionDeadline,
        technicalBidOpenAt,
        financialBidOpenAt,
        useLandedRate: true,
        equityValue: 1000000,
        totalUnitsPerYear: 500000,
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

    // 3b-i. Pay the RfS Document fee — accepting is now gated on this too (see tenders.ts's
    // invitations/respond and rfsDocumentAccessService.ts: it applies to an auto-invited generator
    // exactly the same as an open self-enroll one). Keyed by payerEmail with organizationId: null,
    // same account-less shape a real purchase leaves behind (see payments.ts).
    await Payment.create({
      purpose: 'rfs_document',
      tenderId,
      organizationId: null,
      payerEmail: 'gen@example.com',
      razorpayOrderId: `order_TEST_rfs_document_${tenderId}`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });

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

    // 5. Independent custodian ceremony (routes/vettingCustodian.ts) — two custodians, each with
    // their own emailed link, submit their share independently. The completing custodian's
    // "browser" is simulated here using vettingCrypto.ts's own reconstructPrivateKey/openEnvelope —
    // the exact reference implementation CustodianCeremonyPage.tsx's Web Crypto port mirrors — since
    // there's no real browser in this test.
    const custodianA = await VettingCustodian.create({ name: 'Custodian A', email: `custodian-a-${Date.now()}@test.local` });
    const custodianB = await VettingCustodian.create({ name: 'Custodian B', email: `custodian-b-${Date.now()}@test.local` });
    createdCustodianIds.push(custodianA.id, custodianB.id);

    // Same find-or-update shape as custodianNotificationService.ts's own token issuance (not a
    // plain create) — the tender's real scheduleCustodianNotification timer (routes/tenders.ts) is
    // also live and targets this same custodian/tender/envelope, and given this test's msUntil()
    // buffer, has deterministically already created its own row by the time this runs. Overwriting
    // it here (this test's own issuance is authoritative for what it's about to use) is exactly
    // what a real resend would do too.
    async function issueCustodianToken(custodianId: number, envelope: 'technical' | 'financial'): Promise<string> {
      const { token, tokenHash } = generateOpaqueToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const existing = await VettingCustodianToken.findOne({ where: { custodianId, tenderId, envelope } });
      if (existing) {
        await existing.update({ tokenHash, expiresAt, usedAt: null });
      } else {
        await VettingCustodianToken.create({ custodianId, tenderId, envelope, tokenHash, expiresAt });
      }
      return token;
    }

    async function runCustodianCeremony(
      envelope: 'technical' | 'financial',
      key: Awaited<ReturnType<typeof generateVettingKeypair>>,
      shareIndices: [number, number]
    ) {
      const tokenA = await issueCustodianToken(custodianA.id, envelope);
      const tokenB = await issueCustodianToken(custodianB.id, envelope);

      const shareARes = await request('POST', '/api/vetting-custodian/ceremony/share', {
        share: Buffer.from(key.shares[shareIndices[0]]).toString('base64'),
      }, tokenA);
      expect(shareARes.status).toBe(200);
      expect(shareARes.body.status).toBe('waiting');

      const shareBRes = await request('POST', '/api/vetting-custodian/ceremony/share', {
        share: Buffer.from(key.shares[shareIndices[1]]).toString('base64'),
      }, tokenB);
      expect(shareBRes.status).toBe(200);
      expect(shareBRes.body.status).toBe('ready');
      const otherShare: string = shareBRes.body.otherShare;

      const envelopesRes = await request('GET', '/api/vetting-custodian/ceremony/sealed-envelopes', undefined, tokenB);
      expect(envelopesRes.status).toBe(200);

      const privateKey = await reconstructPrivateKey(
        [new Uint8Array(Buffer.from(otherShare, 'base64')), key.shares[shareIndices[1]]],
        key.fingerprint
      );
      const opened = envelopesRes.body.envelopes.map((e: { id: number; wrappedDataKey: string; iv: string; ciphertext: string }) => ({
        bidId: e.id,
        content: openEnvelope(privateKey, { wrappedDataKey: e.wrappedDataKey, iv: e.iv, ciphertext: e.ciphertext } as SealedEnvelope),
      }));
      const shareFingerprints = [
        crypto.createHash('sha256').update(Buffer.from(otherShare, 'base64')).digest('hex'),
        crypto.createHash('sha256').update(Buffer.from(key.shares[shareIndices[1]])).digest('hex'),
      ];

      const completeRes = await request('POST', '/api/vetting-custodian/ceremony/complete', {
        openedBidIds: opened.map((o: { bidId: number }) => o.bidId),
        opened,
        shareFingerprints,
      }, tokenB);
      expect(completeRes.status).toBe(200);

      return opened;
    }

    await new Promise((r) => setTimeout(r, msUntil(technicalBidOpenAt)));
    const technicalOpened = await runCustodianCeremony('technical', technicalKey, [0, 1]);
    expect(JSON.parse(technicalOpened[0].content)).toEqual({ capacity: '5MW' });

    const decisionRes = await request('POST', `/api/vetting-bids/${bidId}/technical-decision`, {
      decision: 'approved',
      reviewedContent: technicalOpened[0].content,
    }, adminToken);
    expect(decisionRes.status).toBe(200);

    // 6. Financial ceremony opens the approved generator's rate bid.
    await new Promise((r) => setTimeout(r, msUntil(financialBidOpenAt)));
    const financialOpened = await runCustodianCeremony('financial', financialKey, [0, 2]);
    expect(financialOpened).toHaveLength(1);

    // 7. Promote the tender to an auction — the actual connection point under test. Scheduling is
    // mandatory (auctions never go live at generation time), so this needs a real future
    // scheduledStartAt. Admin-only, same as every other step in this dashboard flow.
    const scheduledStartAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const promoteRes = await request('POST', `/api/vetting-bids/${tenderId}/promote-to-auction`, { scheduledStartAt }, adminToken);
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.links).toHaveLength(1);
    expect(promoteRes.body.links[0].alias).toBe('Test Generator Co');
    expect(promoteRes.body.scheduledStartAt).toBe(scheduledStartAt);
    // A read-only admin spectator seat is created alongside every promoted auction (see
    // seedAuctionStandalone's own comment) — the real buyer org getting a seat is a separate,
    // still-pending decision, not this.
    expect(promoteRes.body.spectatorLink.alias).toBe('SPECTATOR');
    createdAuctionIds.push(promoteRes.body.auctionId);

    const auction = await Auction.findByPk(promoteRes.body.auctionId);
    expect(auction).not.toBeNull();
    expect(auction!.status).toBe('scheduled'); // stays scheduled — the in-process timer flips it to 'live' at scheduledStartAt, not here
    expect(Number(auction!.openingBid)).toBe(5.75); // the only approved generator's tariff
    expect(auction!.tenderRef).toBe(tenderId);

    const participants = await AuctionParticipant.findAll({ where: { auctionId: promoteRes.body.auctionId } });
    expect(participants).toHaveLength(2); // the one approved generator + the admin spectator seat
    const generatorParticipant = participants.find((p) => p.role === 'generator');
    expect(generatorParticipant!.alias).toBe('Test Generator Co');
    const spectatorParticipant = participants.find((p) => p.role === 'buyer');
    expect(spectatorParticipant!.alias).toBe('SPECTATOR');
    expect(spectatorParticipant!.organizationId).toBeNull();

    // Promoting the same tender twice is rejected, not silently duplicated.
    const secondPromoteRes = await request('POST', `/api/vetting-bids/${tenderId}/promote-to-auction`, { scheduledStartAt }, adminToken);
    expect(secondPromoteRes.status).toBe(409);

    // 8. EMD is a document now (see EmdSubmission), not money — settling the auction winner is no
    // longer a dedicated route (success charge is dropped, and EMD has no Payment to refund any
    // more). Resolving the winner's EMD is the same generic admin action every other generator's
    // EMD uses — release/invoke via emdSubmissions.ts — exercised end to end in
    // emdSubmissions.test.ts, not duplicated here.
    const emdBefore = await EmdSubmission.findOne({ where: { tenderId, organizationId: generatorReg.body.organizationId } });
    expect(emdBefore!.status).toBe('submitted');
  }, 60000);
});
