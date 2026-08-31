import rateLimit, { type Options } from 'express-rate-limit';

// Every route in this codebase returns JSON, success or error, and every frontend caller does a
// blind `await res.json()` on the response with no content-type check first. express-rate-limit's
// own default 429 body is plain text ("Too many requests, please try again later.") — hitting a
// limiter that never set its own `message` therefore crashes the caller with a JSON.parse
// SyntaxError ("Unexpected token 'T'...") instead of surfacing the real "you're rate limited"
// message. This wraps rateLimit() so every limiter in the app gets the same JSON shape as
// everything else by default; a caller can still pass its own `message` for a route-specific string
// (spread after the default, so it wins) exactly as before.
export function jsonRateLimit(options: Partial<Options> & { windowMs: number; limit: number }) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests — try again shortly.' },
    ...options,
  });
}
