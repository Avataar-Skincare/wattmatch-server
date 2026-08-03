const MSG91_BASE_URL = 'https://control.msg91.com/api/v5/otp';

function toMsg91Mobile(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('91') ? digits : `91${digits}`;
}

export async function sendPhoneOtpViaMsg91(phone: string): Promise<boolean> {
  const authKey = process.env.MSG91_AUTH_KEY;
  if (!authKey) {
    console.warn('MSG91 not configured (MSG91_AUTH_KEY) — skipping phone OTP send.');
    return false;
  }
  const templateId = process.env.MSG91_TEMPLATE_ID;
  const params = new URLSearchParams({ mobile: toMsg91Mobile(phone) });
  if (templateId) params.set('template_id', templateId);

  try {
    const res = await fetch(`${MSG91_BASE_URL}?${params.toString()}`, {
      method: 'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type !== 'success') {
      console.error('MSG91 send OTP failed:', res.status, data);
      return false;
    }
    return true;
  } catch (err) {
    console.error('MSG91 send OTP errored:', err);
    return false;
  }
}

export async function verifyPhoneOtpViaMsg91(phone: string, otp: string): Promise<boolean> {
  const authKey = process.env.MSG91_AUTH_KEY;
  if (!authKey) {
    console.warn('MSG91 not configured (MSG91_AUTH_KEY) — cannot verify phone OTP.');
    return false;
  }
  const params = new URLSearchParams({ mobile: toMsg91Mobile(phone), otp });

  try {
    const res = await fetch(`${MSG91_BASE_URL}/verify?${params.toString()}`, {
      headers: { authkey: authKey },
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.type === 'success';
  } catch (err) {
    console.error('MSG91 verify OTP errored:', err);
    return false;
  }
}
