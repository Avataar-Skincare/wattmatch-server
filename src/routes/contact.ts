import { Router } from 'express';
import { ContactMessage } from '../models/ContactMessage.js';
import { handleCreateError } from '../lib/handleCreateError.js';
import { isValidEmail } from '../lib/validators.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Missing email' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }
    const entry = await ContactMessage.create({ email });
    res.status(201).json({ success: true, message: 'Contact message saved successfully', id: entry.id, createdAt: entry.createdAt });
  } catch (err) {
    console.error('Failed to save contact message:', err);
    handleCreateError(res, err, 'Failed to save message');
  }
});

export default router;
