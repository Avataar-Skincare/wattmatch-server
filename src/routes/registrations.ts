import { Router } from 'express';
import { GeneratorRegistration } from '../models/GeneratorRegistration.js';
import { CIRegistration } from '../models/CIRegistration.js';
import { handleCreateError } from '../lib/handleCreateError.js';
import { sendRegistrationConfirmationEmail } from '../services/email.js';
import { isValidEmail, isValidPhone, isPositiveNumber, normalizePhone } from '../lib/validators.js';

const router = Router();

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
    res.status(201).json({ success: true, message: 'CI registration saved successfully', id: registration.id, createdAt: registration.createdAt });
  } catch (err) {
    console.error('Failed to save CI registration:', err);
    handleCreateError(res, err, 'Failed to save registration');
  }
});

export default router;
