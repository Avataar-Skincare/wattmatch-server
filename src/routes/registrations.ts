import { Router } from 'express';
import { GeneratorRegistration } from '../models/GeneratorRegistration.js';
import { CIRegistration } from '../models/CIRegistration.js';
import { Organization } from '../models/Organization.js';
import { OrganizationToken } from '../models/OrganizationToken.js';
import { TenderRequest } from '../models/TenderRequest.js';
import { handleCreateError } from '../lib/handleCreateError.js';
import { sendRegistrationConfirmationEmail, sendAccountCreatedEmail } from '../services/email.js';
import { generateOpaqueToken } from '../lib/passwordAuth.js';
import { isValidEmail, isValidPhone, isPositiveNumber, normalizePhone } from '../lib/validators.js';

const router = Router();

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // matches organizations.ts's own TTL for this token purpose

function frontendUrl(path: string): string {
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  return `${origin}${path}`;
}

// These lead-capture forms never collect a password, so a real account (if one doesn't already
// exist for this email) is created with none set, and the same 'password_reset'-purpose token
// organizations.ts's forgot-password flow uses is issued immediately — /reset-password consumes it
// identically either way, so no new backend mechanism is needed, just a different email framing
// (sendAccountCreatedEmail vs sendPasswordResetEmail). Silently skipped if an account already
// exists for this email — that person already has a way in, and implying a fresh account would be
// misleading.
// Returns the account either way (existing or freshly created) — the /ci caller needs a real
// buyerOrgId to attach an auto-generated TenderRequest to, regardless of whether this particular
// registration was the one that actually created the account.
async function createAccountAndSendSetPasswordEmail(
  type: 'buyer' | 'generator',
  name: string,
  email: string,
  phone: string,
  capacityMw?: string
): Promise<Organization> {
  const existing = await Organization.findOne({ where: { contactEmail: email } });
  if (existing) return existing;

  const org = await Organization.create({
    type,
    name,
    contactEmail: email,
    contactPhone: phone,
    capacityMw: type === 'generator' && capacityMw ? capacityMw : null,
  });

  const { token, tokenHash } = generateOpaqueToken();
  await OrganizationToken.create({
    organizationId: org.id,
    purpose: 'password_reset',
    tokenHash,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
  });
  await sendAccountCreatedEmail(email, frontendUrl(`/reset-password?token=${encodeURIComponent(token)}`));
  return org;
}

router.post('/generator', async (req, res) => {
  try {
    const { name, company, email, phone, state, capacity, siteLocation, commissioningTimeline, certifications, message } = req.body;
    if (!email || !phone) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }
    if (capacity && !isPositiveNumber(capacity)) {
      return res.status(400).json({ success: false, error: 'Capacity must be a positive number' });
    }
    if (!isValidPhone(phone)) {
      console.warn(`Generator registration for ${email} has an unrecognised phone number: ${phone}`);
    }
    const { countryCode, number } = normalizePhone(phone);
    const registration = await GeneratorRegistration.create({
      name: name || '', company: company || '', email, phone: number, phoneCountryCode: countryCode,
      state: state || '', capacity: capacity || '', siteLocation, commissioningTimeline, certifications, message,
    });
    void sendRegistrationConfirmationEmail(email, 'generator');
    void createAccountAndSendSetPasswordEmail('generator', company || name || email, email, number, capacity || undefined);
    res.status(201).json({ success: true, message: 'Generator registration saved successfully', id: registration.id, createdAt: registration.createdAt });
  } catch (err) {
    console.error('Failed to save generator registration:', err);
    handleCreateError(res, err, 'Failed to save registration');
  }
});

router.post('/ci', async (req, res) => {
  try {
    const { name, company, email, phone, state, load, siteLocation, targetCapacity, tenurePreference, message, consent } = req.body;
    if (!email || !phone) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (consent !== true) {
      return res.status(400).json({ success: false, error: 'Consent is required to submit this registration' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }
    if (load && !isPositiveNumber(load)) {
      return res.status(400).json({ success: false, error: 'Monthly consumption must be a positive number' });
    }
    if (targetCapacity && !isPositiveNumber(targetCapacity)) {
      return res.status(400).json({ success: false, error: 'Max demand must be a positive number' });
    }
    if (tenurePreference && !isPositiveNumber(tenurePreference)) {
      return res.status(400).json({ success: false, error: 'Preferred tenure must be a positive number of years' });
    }
    if (!isValidPhone(phone)) {
      console.warn(`CI registration for ${email} has an unrecognised phone number: ${phone}`);
    }
    const { countryCode, number } = normalizePhone(phone);
    const registration = await CIRegistration.create({
      name: name || '', company: company || '', email, phone: number, phoneCountryCode: countryCode,
      state: state || '', load: load || '', siteLocation, targetCapacity, tenurePreference, message,
      consentGiven: true, consentGivenAt: new Date(),
    });
    void sendRegistrationConfirmationEmail(email, 'ci');
    const org = await createAccountAndSendSetPasswordEmail('buyer', company || name || email, email, number);

    // Buyers no longer post a live tender themselves (see tenders.ts's own comment on this) — they
    // submit a TenderRequest for an admin to price and convert. A buyer arriving through this
    // marketing form would otherwise never see that step at all, so this creates one automatically
    // from the demand-sizing fields the form already collects, landing it straight in the admin's
    // "Pending tender requests" queue — always, even with no target capacity given (stored as '0',
    // a value no real tender ever has since AdminConsolePage's capacity field requires a positive
    // number): admin fills that in themselves at conversion time regardless of source, the same as
    // every other TenderRequest field they're free to edit before posting, so there's no reason to
    // leave a registration stranded with no path to becoming a tender just because this one field
    // was left blank. Best-effort: a failure here shouldn't turn an otherwise successful
    // registration into an error response.
    try {
      const detailParts: string[] = [];
      if (load) detailParts.push(`Monthly consumption: ${load} kWh`);
      if (siteLocation) detailParts.push(`Site location: ${siteLocation}`);
      if (tenurePreference) detailParts.push(`Preferred tenure: ${tenurePreference} years`);
      if (message) detailParts.push(message);
      await TenderRequest.create({
        buyerOrgId: org.id,
        title: `Tender request from ${company || name || email}`,
        requiredCapacityMw: targetCapacity ? String(targetCapacity) : '0',
        requirementsDetail: detailParts.length ? detailParts.join('\n') : null,
      });
    } catch (err) {
      console.error(`Failed to auto-create tender request for CI registration ${registration.id}:`, err);
    }

    res.status(201).json({ success: true, message: 'CI registration saved successfully', id: registration.id, createdAt: registration.createdAt });
  } catch (err) {
    console.error('Failed to save CI registration:', err);
    handleCreateError(res, err, 'Failed to save registration');
  }
});

export default router;
