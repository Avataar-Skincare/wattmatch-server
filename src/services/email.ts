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

const registrationCopy = {
  ci: {
    subject: "We've received your Wattmatch registration",
    paragraphs: [
      'Thank you for your interest in Wattmatch and for taking the time to submit your details.',
      "We've received your response successfully. Our team will review your requirements and get in touch with you shortly to understand your energy needs and explore how Wattmatch can help you access renewable power through a transparent and efficient procurement process.",
      'We appreciate your interest and look forward to connecting with you.',
    ],
  },
  generator: {
    subject: "We've received your Wattmatch registration",
    paragraphs: [
      'Thank you for registering your interest with Wattmatch.',
      "We've received your response successfully. Our team will review the information you've shared and reach out to discuss how we can connect your renewable energy portfolio with qualified Commercial & Industrial (C&I) buyers through our marketplace.",
      'We look forward to working with you.',
    ],
  },
} as const;

export async function sendRegistrationConfirmationEmail(
  email: string,
  role: 'generator' | 'ci',
): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`Registration confirmation email not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — skipping email send to ${email}`);
    return false;
  }
  const { subject, paragraphs } = registrationCopy[role];
  const lines = ['Hi,', '', ...paragraphs, '', 'Warm regards,', 'Team Wattmatch'];
  try {
    await client.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject,
      text: lines.join('\n'),
      html: `<p>Hi,</p>${paragraphs.map((p) => `<p>${p}</p>`).join('')}<p>Warm regards,<br>Team Wattmatch</p>`,
    });
    return true;
  } catch (err) {
    console.error('Registration confirmation email send failed:', err);
    return false;
  }
}
