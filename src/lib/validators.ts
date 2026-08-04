// The default 'libphonenumber-js' export uses trimmed-down "min" metadata,
// which drops number-type classification for most countries (getType() comes
// back undefined for India) — the '/max' entry point carries full metadata.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Wattmatch's default market — an input with no explicit country code
// (no leading "+") is assumed to be Indian rather than rejected.
const DEFAULT_PHONE_COUNTRY = 'IN';

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export interface ParsedPhone {
  countryCode: string; // e.g. "+91"
  number: string; // national number only, e.g. "9876543210"
}

// Accepts any international format libphonenumber-js recognises — an
// explicit country code (e.g. "+44 7911 123456") is honoured as given;
// anything without one is validated as an Indian number. Deliberately not
// restricted to MOBILE/FIXED_LINE type: per-country type classification in
// the phone numbering metadata isn't reliably complete for every country,
// so a general validity check is the more robust bar across countries.
export function isValidPhone(value: string): boolean {
  const phoneNumber = parsePhoneNumberFromString(value, DEFAULT_PHONE_COUNTRY);
  return !!phoneNumber && phoneNumber.isValid();
}

// Splits any accepted variant into a canonical { countryCode, number } pair,
// e.g. "+91 98765-43210" -> { countryCode: '+91', number: '9876543210' },
// "07911 123456" (default country) -> { countryCode: '+44', number: '7911123456' }.
// Falls back to a best-effort digit strip defaulting to India if the value
// isn't parseable at all (leads.ts calls this without a prior validation gate).
export function normalizePhone(value: string): ParsedPhone {
  const phoneNumber = parsePhoneNumberFromString(value, DEFAULT_PHONE_COUNTRY);
  if (phoneNumber && phoneNumber.isValid()) {
    return { countryCode: `+${phoneNumber.countryCallingCode}`, number: phoneNumber.nationalNumber };
  }
  return { countryCode: '+91', number: value.replace(/\D/g, '').slice(-10) };
}

export function isPositiveNumber(value: unknown): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}
