// Dead code: only used by routes/otp.ts, which is no longer mounted.
// Kept commented out in case OTP verification is reintroduced later.
//
// import { redis } from '../lib/redis.js';
// import { sendOtpEmail } from './email.js';
// import { sendOtpSms } from './fast2sms.js';
// import { sendPhoneOtpViaMsg91, verifyPhoneOtpViaMsg91 } from './msg91.js';
//
// // MSG91 requires its own fresh entity/header/template registration through
// // their own platform — no advantage over just fixing Fast2SMS's branding
// // (the WATMCH registration already in motion). Phone OTP stays here.
// const USE_MSG91_FOR_PHONE = false;
//
// export type OtpChannel = 'email' | 'phone';
//
// const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS) || 600;
// const OTP_RESEND_COOLDOWN_SECONDS = 60;
// const OTP_MAX_SENDS_PER_WINDOW = 5;
// const OTP_SEND_WINDOW_SECONDS = 1800;
// const OTP_MAX_VERIFY_ATTEMPTS = 5;
//
// function otpKey(channel: OtpChannel, identifier: string) {
//   return `otp:${channel}:${identifier}`;
// }
//
// function verifiedKey(channel: OtpChannel, identifier: string) {
//   return `otp-verified:${channel}:${identifier}`;
// }
//
// function cooldownKey(channel: OtpChannel, identifier: string) {
//   return `otp-cooldown:${channel}:${identifier}`;
// }
//
// function sendCountKey(channel: OtpChannel, identifier: string) {
//   return `otp-sendcount:${channel}:${identifier}`;
// }
//
// function attemptsKey(channel: OtpChannel, identifier: string) {
//   return `otp-attempts:${channel}:${identifier}`;
// }
//
// export type SendOtpResult =
//   | { ok: true }
//   | { ok: false; reason: 'cooldown'; retryAfterSeconds: number }
//   | { ok: false; reason: 'rate_limited' };
//
// export async function sendOtp(channel: OtpChannel, identifier: string): Promise<SendOtpResult> {
//   const cooldownTtl = await redis.ttl(cooldownKey(channel, identifier));
//   if (cooldownTtl > 0) {
//     return { ok: false, reason: 'cooldown', retryAfterSeconds: cooldownTtl };
//   }
//
//   const sendCount = await redis.incr(sendCountKey(channel, identifier));
//   if (sendCount === 1) {
//     await redis.expire(sendCountKey(channel, identifier), OTP_SEND_WINDOW_SECONDS);
//   }
//   if (sendCount > OTP_MAX_SENDS_PER_WINDOW) {
//     return { ok: false, reason: 'rate_limited' };
//   }
//
//   await redis.del(attemptsKey(channel, identifier));
//   await redis.set(cooldownKey(channel, identifier), '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS);
//
//   if (channel === 'phone' && USE_MSG91_FOR_PHONE) {
//     // MSG91 generates and tracks the actual code on their end — nothing to store here.
//     await sendPhoneOtpViaMsg91(identifier);
//     return { ok: true };
//   }
//
//   const otp = String(Math.floor(1000 + Math.random() * 9000));
//   console.log(`OTP for ${channel}:${identifier} is ${otp}`);
//   await redis.set(otpKey(channel, identifier), otp, 'EX', OTP_TTL_SECONDS);
//   if (channel === 'phone') {
//     await sendOtpSms(identifier, otp);
//   } else {
//     await sendOtpEmail(identifier, otp);
//   }
//   return { ok: true };
// }
//
// export type VerifyOtpResult =
//   | { ok: true }
//   | { ok: false; reason: 'invalid' }
//   | { ok: false; reason: 'too_many_attempts' };
//
// async function trackFailedAttempt(channel: OtpChannel, identifier: string): Promise<VerifyOtpResult> {
//   const attempts = await redis.incr(attemptsKey(channel, identifier));
//   if (attempts === 1) {
//     await redis.expire(attemptsKey(channel, identifier), OTP_TTL_SECONDS);
//   }
//   if (attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
//     await redis.del(attemptsKey(channel, identifier));
//     return { ok: false, reason: 'too_many_attempts' };
//   }
//   return { ok: false, reason: 'invalid' };
// }
//
// export async function verifyOtp(channel: OtpChannel, identifier: string, otp: string): Promise<VerifyOtpResult> {
//   if (channel === 'phone' && USE_MSG91_FOR_PHONE) {
//     const matched = await verifyPhoneOtpViaMsg91(identifier, otp);
//     if (!matched) return trackFailedAttempt(channel, identifier);
//     await redis.del(attemptsKey(channel, identifier));
//     await redis.set(verifiedKey(channel, identifier), '1', 'EX', OTP_TTL_SECONDS);
//     return { ok: true };
//   }
//
//   const key = otpKey(channel, identifier);
//   const stored = await redis.get(key);
//   if (!stored || stored !== otp) {
//     return trackFailedAttempt(channel, identifier);
//   }
//
//   await redis.del(key);
//   await redis.del(attemptsKey(channel, identifier));
//   await redis.set(verifiedKey(channel, identifier), '1', 'EX', OTP_TTL_SECONDS);
//   return { ok: true };
// }
//
// export async function isVerified(channel: OtpChannel, identifier: string): Promise<boolean> {
//   const value = await redis.get(verifiedKey(channel, identifier));
//   return value === '1';
// }
//
// export async function clearVerified(channel: OtpChannel, identifier: string): Promise<void> {
//   await redis.del(verifiedKey(channel, identifier));
// }
