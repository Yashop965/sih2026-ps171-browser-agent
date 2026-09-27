/**
 * Ledger message handlers, extracted from the background service worker.
 *
 * Issue #159 asked for background.ts to be split up. This is step 1 of three.
 *
 * ## Why this one
 *
 * Three cases, thirteen lines, and they were the cheapest place to prove the
 * extraction pattern on code where a mistake is visible. Two independent
 * classes back them — PrivacyLedger and PrivacyAuditLedger, with no shared
 * base — so the boundary below is structural rather than nominal: it names
 * only the four methods these three handlers actually call.
 *
 * That is deliberate. Making both ledgers implement a new shared interface
 * would couple two classes that have no reason to know about each other, and
 * it would be a change to the privacy code to serve a refactor. Structural
 * typing gets the same testability without the coupling.
 *
 * ## What the handlers must preserve
 *
 * `return true` on every case. Once a listener returns true the message
 * channel is held open waiting for sendResponse, so dropping it would make
 * the popup's fetch hang rather than fail. That is the one behaviour with an
 * invisible failure mode, so it is asserted in the tests rather than assumed.
 *
 * CLEAR_LEDGER clears BOTH ledgers. The popup's Clear button is a single
 * control, and a partial clear would leave the audit trail describing
 * redactions the user believes they erased.
 */

export interface LedgerReader {
  getEntries(): unknown;
}

export interface LedgerClearable {
  clear(): void;
}

export type LedgerMessageResponse = unknown;

/**
 * The three ledger cases, as one dispatch.
 *
 * Returns the response to send, or `undefined` when the message is not a
 * ledger message at all. The caller keeps ownership of `sendResponse` so the
 * async/response contract stays in one place.
 */
export function handleLedgerMessage(
  message: { type: string },
  ledgers: { privacy: LedgerReader; audit: LedgerReader },
  clearable: { privacy: LedgerClearable; audit: LedgerClearable }
): LedgerMessageResponse | undefined {
  switch (message.type) {
    case 'GET_PRIVACY_LEDGER':
      return ledgers.privacy.getEntries();

    case 'GET_AUDIT_LOG':
      return ledgers.audit.getEntries();

    case 'CLEAR_LEDGER':
      // Both, always. A partial clear would leave the audit trail describing
      // redactions the user believes they erased.
      clearable.privacy.clear();
      clearable.audit.clear();
      return { success: true };

    default:
      return undefined;
  }
}

/** The message types this module owns. */
export const LEDGER_MESSAGE_TYPES = [
  'GET_PRIVACY_LEDGER',
  'GET_AUDIT_LOG',
  'CLEAR_LEDGER',
] as const;

export function isLedgerMessage(type: string): boolean {
  return (LEDGER_MESSAGE_TYPES as readonly string[]).includes(type);
}
