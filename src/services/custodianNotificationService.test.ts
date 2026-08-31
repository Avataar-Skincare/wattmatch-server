import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { VettingCustodian } from '../models/VettingCustodian.js';
import { VettingCustodianToken } from '../models/VettingCustodianToken.js';
import { notifyOverdueCustodians, notifyCustodians } from './custodianNotificationService.js';

let buyerOrgId: number;
let custodianId: number;
let secondCustodianId: number;
const createdTenderIds: number[] = [];

beforeAll(async () => {
  const buyer = await Organization.create({
    type: 'buyer',
    name: 'Notify Overdue Test Buyer',
    contactEmail: `notify-overdue-buyer-${Date.now()}@test.local`,
    contactPhone: '9000000000',
  });
  buyerOrgId = buyer.id;

  const custodian = await VettingCustodian.create({
    name: 'Notify Overdue Test Custodian',
    email: `notify-overdue-custodian-${Date.now()}@test.local`,
  });
  custodianId = custodian.id;

  const secondCustodian = await VettingCustodian.create({
    name: 'Notify Overdue Test Second Custodian',
    email: `notify-overdue-custodian-2-${Date.now()}@test.local`,
  });
  secondCustodianId = secondCustodian.id;
});

afterAll(async () => {
  for (const id of createdTenderIds) {
    await VettingCustodianToken.destroy({ where: { tenderId: id } });
    await Tender.destroy({ where: { id } });
  }
  await VettingCustodian.destroy({ where: { id: [custodianId, secondCustodianId] } });
  await Organization.destroy({ where: { id: buyerOrgId } });
});

describe('notifyOverdueCustodians', () => {
  it('notifies for an envelope whose open date has already passed and has no token yet', async () => {
    const tender = await Tender.create({
      buyerOrgId,
      title: `Overdue technical ${Date.now()}`,
      requiredCapacityMw: '5',
      technicalBidOpenAt: new Date(Date.now() - 60_000),
      financialBidOpenAt: new Date(Date.now() + 60_000), // not due yet
    });
    createdTenderIds.push(tender.id);

    await notifyOverdueCustodians();

    const technicalToken = await VettingCustodianToken.findOne({ where: { custodianId, tenderId: tender.id, envelope: 'technical' } });
    expect(technicalToken).not.toBeNull();

    const financialToken = await VettingCustodianToken.findOne({ where: { custodianId, tenderId: tender.id, envelope: 'financial' } });
    expect(financialToken).toBeNull();
  });

  it('does not re-notify an envelope that already has a token', async () => {
    const tender = await Tender.create({
      buyerOrgId,
      title: `Already notified ${Date.now()}`,
      requiredCapacityMw: '5',
      technicalBidOpenAt: new Date(Date.now() - 60_000),
    });
    createdTenderIds.push(tender.id);

    await notifyOverdueCustodians();
    const firstToken = await VettingCustodianToken.findOne({ where: { custodianId, tenderId: tender.id, envelope: 'technical' } });
    expect(firstToken).not.toBeNull();
    const firstHash = firstToken!.tokenHash;

    await notifyOverdueCustodians();
    const secondToken = await VettingCustodianToken.findOne({ where: { custodianId, tenderId: tender.id, envelope: 'technical' } });
    // Same row, unchanged — a second overdue pass must not re-mint/re-send for something already notified.
    expect(secondToken!.tokenHash).toBe(firstHash);
  });

  // Regression coverage for the per-custodian granularity fix: previously the "already notified"
  // check only asked whether ANY token existed for the tender/envelope, so one custodian's email
  // succeeding while a second's failed would permanently stop the self-heal from ever retrying the
  // second custodian.
  it('retries only the specific custodian missing a token, without touching one that already has one', async () => {
    const tender = await Tender.create({
      buyerOrgId,
      title: `Partial notify ${Date.now()}`,
      requiredCapacityMw: '5',
      technicalBidOpenAt: new Date(Date.now() - 60_000),
    });
    createdTenderIds.push(tender.id);

    // Simulates the first custodian having already been notified successfully (by the original
    // timer, or an earlier tick), while the second one is missing entirely.
    await notifyCustodians(tender.id, 'technical', [custodianId]);
    const firstToken = await VettingCustodianToken.findOne({ where: { custodianId, tenderId: tender.id, envelope: 'technical' } });
    expect(firstToken).not.toBeNull();
    const firstHash = firstToken!.tokenHash;

    await notifyOverdueCustodians();

    const firstTokenAfter = await VettingCustodianToken.findOne({ where: { custodianId, tenderId: tender.id, envelope: 'technical' } });
    expect(firstTokenAfter!.tokenHash).toBe(firstHash); // untouched, not re-minted

    const secondToken = await VettingCustodianToken.findOne({ where: { custodianId: secondCustodianId, tenderId: tender.id, envelope: 'technical' } });
    expect(secondToken).not.toBeNull(); // the actually-missing one got caught and notified
  });

  it('ignores a tender with no ceremony dates set', async () => {
    const tender = await Tender.create({
      buyerOrgId,
      title: `No ceremony dates ${Date.now()}`,
      requiredCapacityMw: '5',
    });
    createdTenderIds.push(tender.id);

    await notifyOverdueCustodians();

    const token = await VettingCustodianToken.findOne({ where: { custodianId, tenderId: tender.id } });
    expect(token).toBeNull();
  });
});
