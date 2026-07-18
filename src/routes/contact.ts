import { Router } from 'express';
import { ContactMessage } from '../models/ContactMessage.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }
    const entry = await ContactMessage.create({ email });
    res.status(201).json({ id: entry.id });
  } catch {
    res.status(500).json({ error: 'Failed to save message' });
  }
});

export default router;
