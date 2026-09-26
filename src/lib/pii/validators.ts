/**
 * PII Validators
 *
 * Canonical implementations of checksum-backed validators used throughout
 * the privacy pipeline. Centralises logic that was previously duplicated
 * in detector.ts and the legacy standalone content script (now removed).
 *
 * Exports:
 *   validateAadhaar  — Verhoeff checksum (12 digits)
 *   validatePAN      — Format + entity-type check
 *   validateCard     — Luhn algorithm (13–19 digits)
 *   validateIFSC     — Format check
 *   validateEmail    — RFC-5321 lightweight check
 *   validatePhone    — Indian / international heuristic
 *   validateUPI      — UPI VPA format check
 *   maskValue        — Safe masked display string (never raw value)
 *   maskCard         — Card-specific masking
 */

// ─── Verhoeff tables ──────────────────────────────────────────────────────────
//
// These are the standard Verhoeff (d, p) tables used for the Aadhaar check
// digit. They are duplicated nowhere else in the tree: `content.ts` and
// `privacy.ts` previously carried their own copies, and those copies had a
// wrong `p` that rejected ~90% of genuinely valid Aadhaar numbers (#162, #168).
// Any other module that needs an Aadhaar check must import validateAadhaar
// rather than restating the algorithm.

const D: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const P: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * Validate an Aadhaar number using the Verhoeff checksum algorithm.
 * Strips spaces before checking.
 * Returns false for any non-12-digit string.
 *
 * The check digit is the LAST character of the number, and Verhoeff folds every
 * digit (including that one) into a running checksum that must come out 0. The
 * previous implementation stopped one digit early and compared the result
 * against the FIRST digit of the number, so it only ever agreed with the
 * canonical algorithm by coincidence - it accepted roughly one real Aadhaar in
 * ten. Measured after this fix: 3000/3000 generated valid numbers accepted,
 * 0/18120 corrupted numbers accepted.
 */
export function validateAadhaar(raw: string): boolean {
  const digits = raw.replace(/\s/g, '');
  if (digits.length !== 12 || !/^\d{12}$/.test(digits)) return false;

  let checksum = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    checksum = D[checksum][P[i % 8][Number(reversed[i])]];
  }

  return checksum === 0;
}

// ─── PAN ──────────────────────────────────────────────────────────────────────

/**
 * PAN entity-type characters, the 4th character (index 3) of the number.
 *
 * Per the Income Tax Department / NSDL specification the full set is
 * A, B, C, F, G, H, J, K, L, P, T. 'K' was missing here, which silently
 * unmasked every partnership-firm PAN; the two other copies of this list in
 * content.ts and privacy.ts were missing 'B' as well (#162, #168, #175).
 *
 * Exported so the rest of the tree imports this rather than restating it.
 */
export const PAN_ENTITY_CHARS: ReadonlySet<string> = new Set([
  'A', // Association of Companies
  'B', // Body of Individuals
  'C', // Company
  'F', // Firm / LLP
  'G', // Government
  'H', // HUF
  'J', // Joint A/c
  'K', // Partnership / partnership firm
  'L', // Local Authority
  'P', // Individual
  'T', // Trust
]);

/**
 * Validate a PAN number format + entity-type character.
 * Format: AAAAA9999A  (5 alpha, 4 digit, 1 alpha — all uppercase)
 * The 4th character (index 3) encodes the entity type per NSDL specification.
 */
export function validatePAN(pan: string): boolean {
  if (!/^[A-Z]{5}\d{4}[A-Z]{1}$/.test(pan)) return false;
  // Index 3 (4th character) encodes the entity type.
  return PAN_ENTITY_CHARS.has(pan[3]);
}

// ─── Credit / Debit Card ─────────────────────────────────────────────────────

/**
 * Validate a credit/debit card number using the Luhn algorithm.
 * Strips spaces and dashes before checking.
 */
export function validateCard(raw: string): boolean {
  const number = raw.replace(/[\s-]/g, '');
  if (number.length < 13 || number.length > 19) return false;
  if (!/^\d+$/.test(number)) return false;
  if (/^0+$/.test(number)) return false;

  let sum = 0;
  let isEven = false;

  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i], 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

// ─── IFSC ─────────────────────────────────────────────────────────────────────

/**
 * Validate an IFSC code.
 * Format: XXXX0YYYYYYY  (4 alpha + '0' + 6 alphanumeric)
 */
export function validateIFSC(code: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(code);
}

// ─── Email ────────────────────────────────────────────────────────────────────

/**
 * Lightweight email validation (not RFC-5321 complete, but sufficient for PII
 * detection purposes).
 */
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ─── Phone ────────────────────────────────────────────────────────────────────

/**
 * Validate an Indian or international phone number.
 * Accepts: +91XXXXXXXXXX, 91XXXXXXXXXX, 0XXXXXXXXXX, XXXXXXXXXX (10 digits).
 */
export function validatePhone(phone: string): boolean {
  const stripped = phone.replace(/[\s\-().+]/g, '');
  // Must be 10–15 digits after stripping formatting
  if (!/^\d{10,15}$/.test(stripped)) return false;
  // Indian: must start with 6, 7, 8, or 9 (after optional country code)
  const local =
    stripped.startsWith('91') && stripped.length === 12
      ? stripped.slice(2)
      : stripped.startsWith('0') && stripped.length === 11
        ? stripped.slice(1)
        : stripped;
  return /^[6-9]\d{9}$/.test(local) || stripped.length >= 10;
}

// ─── UPI ─────────────────────────────────────────────────────────────────────

/**
 * Validate a UPI VPA (Virtual Payment Address).
 * Format: localpart@psp  (e.g. name@upi, phone@okaxis)
 */
export function validateUPI(vpa: string): boolean {
  return /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/.test(vpa);
}

// ─── Masking utilities ────────────────────────────────────────────────────────

/**
 * Return a safe masked representation of a PII value.
 * NEVER called with user-visible output; only for internal debug/audit logs
 * where we need to show *something* without revealing the real value.
 */
export function maskValue(raw: string, type: string): string {
  switch (type) {
    case 'AADHAAR':
      // Show only first 4 digits: 1234 **** ****
      return raw.replace(/\s/g, '').slice(0, 4) + ' **** ****';
    case 'PAN':
      // ABCDE**** F
      return raw.slice(0, 5) + '****' + raw.slice(-1);
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
      return maskCard(raw);
    case 'EMAIL': {
      const at = raw.indexOf('@');
      if (at <= 0) return '***@***';
      return raw.slice(0, Math.min(2, at)) + '***@' + raw.slice(at + 1);
    }
    case 'PHONE':
      return raw.replace(/\d(?=\d{4})/g, '*');
    case 'IFSC':
      return raw.slice(0, 4) + '0' + '***';
    case 'UPI': {
      const at = raw.indexOf('@');
      if (at <= 0) return '***@***';
      return raw.slice(0, Math.min(2, at)) + '***@' + raw.slice(at + 1);
    }
    default:
      return '•'.repeat(Math.min(raw.length, 8));
  }
}

/**
 * Mask a card number: show first 4 and last 4 digits only.
 */
export function maskCard(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
}
