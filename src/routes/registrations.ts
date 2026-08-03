import { Router } from 'express';
import { GeneratorRegistration } from '../models/GeneratorRegistration.js';
import { CIRegistration } from '../models/CIRegistration.js';
import { handleCreateError } from '../lib/handleCreateError.js';
import { isVerified, clearVerified } from '../services/otpService.js';
import { isValidEmail, isValidIndianPhone, isPositiveNumber } from '../lib/validators.js';

const router = Router();

async function requireVerifiedContact(email: string, phone: string): Promise<string | null> {
  const [emailOk, phoneOk] = await Promise.all([isVerified('email', email), isVerified('phone', phone)]);
  if (!emailOk) return 'Email is not verified';
  if (!phoneOk) return 'Phone is not verified';
  return null;
}

router.post('/generator', async (req, res) => {
  try {
    const { name, company, email, phone, state, capacity, siteLocation, commissioningTimeline, certifications, message } = req.body;
    if (!name || !company || !email || !phone || !state || !capacity) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }
    if (!isValidIndianPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid 10-digit Indian mobile number' });
    }
    if (!isPositiveNumber(capacity)) {
      return res.status(400).json({ success: false, error: 'Capacity must be a positive number' });
    }
    const verificationError = await requireVerifiedContact(email, phone);
    if (verificationError) {
      return res.status(400).json({ success: false, error: verificationError });
    }
    const registration = await GeneratorRegistration.create({
      name, company, email, phone, state, capacity, siteLocation, commissioningTimeline, certifications, message,
    });
    await Promise.all([clearVerified('email', email), clearVerified('phone', phone)]);
    res.status(201).json({ success: true, message: 'Generator registration saved successfully', id: registration.id, createdAt: registration.createdAt });
  } catch (err) {
    console.error('Failed to save generator registration:', err);
    handleCreateError(res, err, 'Failed to save registration');
  }
});

router.post('/ci', async (req, res) => {
  try {
    const { name, company, email, phone, state, load, siteLocation, targetCapacity, tenurePreference, message, consent } = req.body;
    if (!name || !company || !email || !phone || !state || !load) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (consent !== true) {
      return res.status(400).json({ success: false, error: 'Consent is required to submit this registration' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }
    if (!isValidIndianPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid 10-digit Indian mobile number' });
    }
    if (!isPositiveNumber(load)) {
      return res.status(400).json({ success: false, error: 'Monthly consumption must be a positive number' });
    }
    if (tenurePreference && !isPositiveNumber(tenurePreference)) {
      return res.status(400).json({ success: false, error: 'Preferred tenure must be a positive number of years' });
    }
    const verificationError = await requireVerifiedContact(email, phone);
    if (verificationError) {
      return res.status(400).json({ success: false, error: verificationError });
    }
    const registration = await CIRegistration.create({
      name, company, email, phone, state, load, siteLocation, targetCapacity, tenurePreference, message,
      consentGiven: true, consentGivenAt: new Date(),
    });
    await Promise.all([clearVerified('email', email), clearVerified('phone', phone)]);
    res.status(201).json({ success: true, message: 'CI registration saved successfully', id: registration.id, createdAt: registration.createdAt });
  } catch (err) {
    console.error('Failed to save CI registration:', err);
    handleCreateError(res, err, 'Failed to save registration');
  }
});

export default router;
