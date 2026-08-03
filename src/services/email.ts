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
