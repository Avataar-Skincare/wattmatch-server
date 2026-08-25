import nodemailer from 'nodemailer';
import { SES, SendRawEmailCommand } from '@aws-sdk/client-ses';

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

// EMAIL_PROVIDER switches the transport; every sendXxxEmail function below is unchanged either way
// — see TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's Tech Stack section ("Email delivery — AWS SES,
// already decided, not yet migrated"). Defaults to the existing SMTP/nodemailer behavior so local
// dev and CI need zero AWS setup; set EMAIL_PROVIDER=ses once SES production access is granted
// (new SES accounts start in sandbox mode) and SES_FROM_EMAIL is a domain-verified sender.
function buildTransporter() {
  const provider = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  if (provider === 'ses') {
    // AWS credentials come from the same default provider chain as every other AWS client in this
    // codebase (IAM role in production, local AWS config for dev/testing) — see lib/secrets.ts's
    // SecretsManagerClient for the identical pattern. Nothing SES-specific to configure beyond
    // region and a verified sender.
    const ses = new SES({ region: process.env.AWS_REGION || 'ap-south-1' });
    // @types/nodemailer's TransportOptions union doesn't model the SES transport (a known gap in
    // the community types — nodemailer's own runtime, lib/ses-transport/index.js, supports it fine).
    return nodemailer.createTransport({ SES: { ses, aws: { SendRawEmailCommand } } } as unknown as Parameters<typeof nodemailer.createTransport>[0]);
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

function getTransporter() {
  if (transporter) return transporter;
  transporter = buildTransporter();
  return transporter;
}

// Single resolution point for the From address across both providers — SES requires the address to
// be a verified identity (or part of a verified domain); SMTP just needs any address the relay
// accepts.
function fromAddress(): string | undefined {
  return process.env.EMAIL_FROM || process.env.SES_FROM_EMAIL || process.env.SMTP_FROM || process.env.SMTP_USER;
}

export async function sendOtpEmail(email: string, otp: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`OTP email not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — skipping email send. OTP for ${email} is ${otp}`);
    return false;
  }
  try {
    await client.sendMail({
      from: fromAddress(),
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

export async function sendEmailVerificationEmail(email: string, verifyUrl: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`Email verification not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — skipping send. Verify URL for ${email} is ${verifyUrl}`);
    return false;
  }
  try {
    await client.sendMail({
      from: fromAddress(),
      to: email,
      subject: 'Verify your Wattmatch account',
      text: `Verify your Wattmatch account by opening this link: ${verifyUrl}\n\nThis link expires in 24 hours. If you didn't create this account, ignore this email.`,
      html: `<p>Verify your Wattmatch account by clicking the link below.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours. If you didn't create this account, ignore this email.</p>`,
    });
    return true;
  } catch (err) {
    console.error('Email verification send failed:', err);
    return false;
  }
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`Password reset email not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — skipping send. Reset URL for ${email} is ${resetUrl}`);
    return false;
  }
  try {
    await client.sendMail({
      from: fromAddress(),
      to: email,
      subject: 'Reset your Wattmatch password',
      text: `Reset your Wattmatch password by opening this link: ${resetUrl}\n\nThis link expires in 1 hour and can only be used once. If you didn't request this, ignore this email — your password will not change.`,
      html: `<p>Reset your Wattmatch password by clicking the link below.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour and can only be used once. If you didn't request this, ignore this email — your password will not change.</p>`,
    });
    return true;
  } catch (err) {
    console.error('Password reset email send failed:', err);
    return false;
  }
}

// Sent when the marketing lead-capture forms (registrations.ts) also create a real Organization
// account behind the scenes — the lead form never collects a password, so this reuses the same
// 'password_reset'-purpose token/link the forgot-password flow uses (organizations.ts's
// /reset-password consumes either indistinguishably), just framed as first-time setup rather than
// a reset.
export async function sendAccountCreatedEmail(email: string, setPasswordUrl: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`Account-created email not configured — skipping send. Set-password URL for ${email} is ${setPasswordUrl}`);
    return false;
  }
  try {
    await client.sendMail({
      from: fromAddress(),
      to: email,
      subject: 'Your Wattmatch account is ready — set your password',
      text: `Thanks for registering with Wattmatch. We've created your account — set a password to log in: ${setPasswordUrl}\n\nThis link expires in 1 hour. If you didn't register with us, ignore this email.`,
      html: `<p>Thanks for registering with Wattmatch. We've created your account — set a password to log in.</p><p><a href="${setPasswordUrl}">${setPasswordUrl}</a></p><p>This link expires in 1 hour. If you didn't register with us, ignore this email.</p>`,
    });
    return true;
  } catch (err) {
    console.error('Account-created email send failed:', err);
    return false;
  }
}

// Stage 7: "Approved generators receive a scheduled auction link... reflected in the profile."
// The join link itself is a signed, per-participant token (auctionTokens.ts) — this email is the
// delivery mechanism the plan calls for, sent once per generator when their tender is promoted to
// a live auction (vettingAuctionBridge.ts).
export async function sendAuctionJoinLinkEmail(email: string, auctionTitle: string, joinUrl: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`Auction join-link email not configured — skipping send. Join URL for ${email} is ${joinUrl}`);
    return false;
  }
  try {
    await client.sendMail({
      from: fromAddress(),
      to: email,
      subject: `You're through to the live auction: "${auctionTitle}"`,
      text: `Your bid was approved and the tender has moved to a live auction: "${auctionTitle}". Join here: ${joinUrl}\n\nThis link is unique to you — do not share it.`,
      html: `<p>Your bid was approved and the tender has moved to a live auction: <strong>${auctionTitle}</strong>.</p><p>Join here: <a href="${joinUrl}">${joinUrl}</a></p><p>This link is unique to you — do not share it.</p>`,
    });
    return true;
  } catch (err) {
    console.error('Auction join-link email send failed:', err);
    return false;
  }
}

export async function sendTenderInvitationEmail(email: string, tenderTitle: string, loginUrl: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) {
    console.warn(`Tender invitation email not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — skipping send. Login URL for ${email} is ${loginUrl}`);
    return false;
  }
  try {
    await client.sendMail({
      from: fromAddress(),
      to: email,
      subject: `You've been invited to bid on "${tenderTitle}"`,
      text: `Wattmatch has matched your organization to a tender: "${tenderTitle}". Log in to view the full requirements and respond: ${loginUrl}`,
      html: `<p>Wattmatch has matched your organization to a tender: <strong>${tenderTitle}</strong>.</p><p>Log in to view the full requirements and respond: <a href="${loginUrl}">${loginUrl}</a></p>`,
    });
    return true;
  } catch (err) {
    console.error('Tender invitation email send failed:', err);
    return false;
  }
}

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
      from: fromAddress(),
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
