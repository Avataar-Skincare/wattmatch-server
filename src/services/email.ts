import nodemailer from 'nodemailer';

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
  return transporter;
}

export async function sendOtpEmail(email: string, otp: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`OTP email not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — skipping email send. OTP for ${email} is ${otp}`);
    return false;
  }
  try {
    await client.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Your Wattmatch verification code',
      text: `Your Wattmatch verification code is ${otp}. It expires in a few minutes.`,
    });
    return true;
  } catch (err) {
    console.error('OTP email send failed:', err);
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendRegistrationConfirmationEmail(
  email: string,
  name: string,
  role: 'generator' | 'ci',
): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`Registration confirmation email not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — skipping email send to ${email}`);
    return false;
  }
  const roleLabel = role === 'generator' ? 'generator' : 'C&I buyer';
  try {
    await client.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: "We've received your Wattmatch registration",
      text: `Hi ${name},\n\nThanks for registering with Wattmatch as a ${roleLabel}. Our team will review your details and be in touch shortly.\n\n— Team Wattmatch`,
      html: `<p>Hi ${escapeHtml(name)},</p><p>Thanks for registering with Wattmatch as a ${roleLabel}. Our team will review your details and be in touch shortly.</p><p>— Team Wattmatch</p>`,
    });
    return true;
  } catch (err) {
    console.error('Registration confirmation email send failed:', err);
    return false;
  }
}
