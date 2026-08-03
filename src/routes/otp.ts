import { Router } from 'express';
import { sendOtp, verifyOtp, type OtpChannel } from '../services/otpService.js';
import { isValidEmail, isValidIndianPhone } from '../lib/validators.js';

const router = Router();

function isValidChannel(channel: unknown): channel is OtpChannel {
  return channel === 'email' || channel === 'phone';
}

function isValidIdentifier(channel: OtpChannel, identifier: string): boolean {
  return channel === 'email' ? isValidEmail(identifier) : isValidIndianPhone(identifier);
}

router.post('/send', async (req, res) => {
  try {
    const { channel, identifier } = req.body;
    if (!isValidChannel(channel) || !identifier) {
      return res.status(400).json({ success: false, error: 'channel must be "email" or "phone", and identifier is required' });
    }
    if (!isValidIdentifier(channel, identifier)) {
      return res.status(400).json({
        success: false,
        error: channel === 'email' ? 'Enter a valid email address' : 'Enter a valid 10-digit Indian mobile number',
      });
    }
    const result = await sendOtp(channel, identifier);
    if (!result.ok) {
      if (result.reason === 'cooldown') {
        return res.status(429).json({
          success: false,
          error: `Please wait ${result.retryAfterSeconds}s before requesting another code.`,
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      return res.status(429).json({ success: false, error: 'Too many code requests. Please try again later.' });
    }
    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    console.error('Failed to send OTP:', err);
    res.status(500).json({ success: false, error: 'Failed to send OTP' });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { channel, identifier, otp } = req.body;
    if (!isValidChannel(channel) || !identifier || !otp) {
      return res.status(400).json({ success: false, error: 'channel, identifier, and otp are required' });
    }
    const result = await verifyOtp(channel, identifier, String(otp));
    if (!result.ok) {
      if (result.reason === 'too_many_attempts') {
        return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Please request a new code.' });
      }
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP' });
    }
    res.json({ success: true, message: 'OTP verified' });
  } catch (err) {
    console.error('Failed to verify OTP:', err);
    res.status(500).json({ success: false, error: 'Failed to verify OTP' });
  }
});

export default router;
