import { Router } from 'express';
import { CILead } from '../models/CILead.js';
import { GeneratorLead } from '../models/GeneratorLead.js';

const router = Router();

router.post('/ci', async (req, res) => {
  try {
    const { name, company, email, phone, state, load, message } = req.body;
    if (!name || !company || !email || !phone || !state) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const lead = await CILead.create({ name, company, email, phone, state, load, message });
    res.status(201).json({ id: lead.id });
  } catch (err) {
    console.error('Failed to save CI lead:', err);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

router.post('/generator', async (req, res) => {
  try {
    const { name, company, email, phone, state, capacity, message } = req.body;
    if (!name || !company || !email || !phone || !state) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const lead = await GeneratorLead.create({ name, company, email, phone, state, capacity, message });
    res.status(201).json({ id: lead.id });
  } catch (err) {
    console.error('Failed to save generator lead:', err);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

export default router;
