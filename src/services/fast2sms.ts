// Dead code: only used by services/otpService.ts, which is no longer wired
// up (OTP verification removed from the registration flow). Kept commented
// out in case it's reintroduced later.
//
// export async function sendOtpSms(mobile: string, otp: string): Promise<boolean> {
//   const apiKey = process.env.OTP_SMS_API_KEY;
//   const senderId = process.env.OTP_SMS_SENDER_ID;
//   const templateId = process.env.OTP_SMS_TEMPLATE_ID;
//   if (!apiKey || !senderId || !templateId) {
//     console.warn(`OTP SMS not configured (OTP_SMS_API_KEY/OTP_SMS_SENDER_ID/OTP_SMS_TEMPLATE_ID) — skipping SMS send. OTP for ${mobile} is ${otp}`);
//     return false;
//   }
//   try {
//     const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&route=dlt&sender_id=${senderId}&message=${templateId}&variables_values=${otp}%7C&flash=0&numbers=${mobile}`;
//     const res = await fetch(url);
//     if (!res.ok) {
//       console.error('Fast2SMS request failed:', res.status, await res.text());
//       return false;
//     }
//     return true;
//   } catch (err) {
//     console.error('Fast2SMS request errored:', err);
//     return false;
//   }
// }
