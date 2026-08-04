import { Router } from 'express';
import { CILead } from '../models/CILead.js';
import { GeneratorLead } from '../models/GeneratorLead.js';
import { handleCreateError } from '../lib/handleCreateError.js';
import { sendRegistrationConfirmationEmail } from '../services/email.js';
import { isValidEmail, isValidPhone, normalizePhone } from '../lib/validators.js';

const router = Router();

router.post('/ci', async (req, res) => {
  try {
    const { name, company, email, phone, state, load, message } = req.body;
    if (!name || !company || !email || !phone || !state) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }
    if (!isValidPhone(phone)) {
      console.warn(`Lead for ${email} has an unrecognised phone number: ${phone}`);
    }
    const { countryCode, number } = normalizePhone(phone);
    const lead = await CILead.create({ name, company, email, phone: number, phoneCountryCode: countryCode, state, load, message });
    void sendRegistrationConfirmationEmail(email, 'ci');
    res.status(201).json({ success: true, message: 'CI lead saved successfully', id: lead.id, createdAt: lead.createdAt });
  } catch (err) {
    console.error('Failed to save CI lead:', err);
    handleCreateError(res, err, 'Failed to save lead');
  }
});

router.post('/generator', async (req, res) => {
  try {
    const { name, company, email, phone, state, capacity, message } = req.body;
    if (!name || !company || !email || !phone || !state) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }
    if (!isValidPhone(phone)) {
      console.warn(`Lead for ${email} has an unrecognised phone number: ${phone}`);
    }
    const { countryCode, number } = normalizePhone(phone);
    const lead = await GeneratorLead.create({ name, company, email, phone: number, phoneCountryCode: countryCode, state, capacity, message });
    void sendRegistrationConfirmationEmail(email, 'generator');
    res.status(201).json({ success: true, message: 'Generator lead saved successfully', id: lead.id, createdAt: lead.createdAt });
  } catch (err) {
    console.error('Failed to save generator lead:', err);
    handleCreateError(res, err, 'Failed to save lead');
  }
});

export default router;
