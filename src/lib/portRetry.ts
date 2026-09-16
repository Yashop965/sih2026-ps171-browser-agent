/**
 * Port-retry helper for service-worker → content-script messaging.
 *
 * When the agent issues a navigating action (CLICK on a link, KEY/Enter that
 * submits a search, NAVIGATE) the tab's content port disconnects and the
 * content script re-injects on the new page. There is a brief window after
 * that where `browser.tabs.sendMessage(tabId, ...)` either rejects with
 * "Receiving end does not exist" / "Could not establish connection" or
 * resolves `undefined` (no listener attached yet). Treating that as a hard
 * failure ends the whole run; instead we retry a few times so the re-attaching
 * content script gets a moment.
 *
 * Extracted from background.ts's extractChannel so the retry behaviour is
 * unit-testable with fake async functions (no live browser APIs needed).
 */

/** Matches the transient "port not up yet" errors from tabs.sendMessage. */
export const PORT_NOT_READY =
  /Receiving end does not exist|Could not establish connection|No recipient|disconnect/i;

export function isPortNotReady(err: unknown): boolean {
  return PORT_NOT_READY.test(String(err));
}

export interface PortRetryOptions {
  /** Total attempts (default 4 - one initial + up to 3 retries). */
  attempts?: number;
  /** Delay between retries in ms (default 400). */
  delayMs?: number;
  /** Optional injectable clock so tests don't sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PortRetryResult<T> {
  ok: boolean;
  /** Present when ok is true. */
  value?: T;
  /** Present when ok is false. */
  error?: string;
  /** True when the failure was the transient port-not-ready case (retriable). */
  transient?: boolean;
}

/**
 * Runs `fetch` and retries while it either throws a port-not-ready error or
 * returns a value `isNoSnapshot` flags as "no listener yet" (e.g. `undefined`).
 * A genuine (non-port) error is returned immediately, not retried - a broken
 * page or wrong tab shouldn't loop for seconds.
 */
export async function withPortRetry<T>(
  fetch: () => Promise<T | undefined>,
  isNoSnapshot: (v: T | undefined) => boolean,
  opts: PortRetryOptions = {},
): Promise<PortRetryResult<T>> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const toMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  let lastError = 'unknown';

  for (let i = 0; i < attempts; i++) {
    let value: T | undefined;
    try {
      value = await fetch();
    } catch (e) {
      lastError = toMessage(e);
      // Only retry transient port errors; anything else is a real failure.
      if (isPortNotReady(e) && i < attempts - 1) {
        await sleep(delayMs);
        continue;
      }
      break;
    }
    if (value === undefined || isNoSnapshot(value)) {
      // No listener yet (port mid-attach): retry unless this is the last try.
      if (i < attempts - 1) {
        await sleep(delayMs);
        continue;
      }
      return { ok: false, error: 'No snapshot', transient: true };
    }
    return { ok: true, value };
  }

  // Retried to exhaustion (or a genuine error broke the loop).
  return {
    ok: false,
    error: lastError,
    // If we exhausted the loop on transient no-snapshots without ever getting a
    // value, treat it as transient (retriable by the caller); a hard throw is not.
    transient: isPortNotReady(lastError),
  };
}
