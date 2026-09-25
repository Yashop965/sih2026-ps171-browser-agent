/**
 * #142: VLM offscreen host — the service-worker side of the on-device
 * Florence-2 pipeline.
 *
 * The pipeline itself runs in a dedicated MODULE WORKER owned by a blank
 * offscreen document (vlm-host.html): that context is the ONE place in the
 * extension that can both `import()` the bundled onnxruntime-web loader
 * (vlm/ort/*.mjs - the thing the content-script isolated world and the SW
 * scope cannot) and expose WebGPU. The worker bundle + relay are built
 * resources; this module only manages the offscreen doc's lifecycle and
 * the SW <-> relay message protocol (vlm-host-relay.js handles the
 * relay <-> worker half).
 *
 * PII boundary (the #100 rule, unchanged): callers pass a screenshot
 * data-URL in; only OCR TEXT / boxes / a pure VisionStatus come back.
 * Pixels never enter the offscreen page's DOM and never reach the LLM.
 */
import type { VisionStatus } from './vision/florence2';

/** Offscreen page (WXT unlisted-page, dist root). */
const OFFSCREEN_PAGE = 'vlm-host.html';
/**
 * Offscreen create reasons. Chrome's stable enum is LOCAL_STORAGE et al.;
 * CUSTOM_WORKER was added later - try it first (the honest one: this doc
 * exists to host a worker), fall back to LOCAL_STORAGE on older Chrome.
 */
const OFFSCREEN_REASONS: Array<Array<string>> = [['CUSTOM_WORKER'], ['LOCAL_STORAGE']];
const OFFSCREEN_JUSTIFICATION =
  '#142: host the on-device VLM (Florence-2) in a dedicated module worker; the offscreen document only owns the worker and relays OCR/status messages.';

/** In-flight createDocument dedupe (concurrent callers share one creation). */
let creating: Promise<void> | null = null;

/**
 * Ensure the offscreen VLM host document exists. Idempotent: a no-op when
 * it is already open. Tries the create reasons in order (newer Chrome
 * accepts CUSTOM_WORKER, older Chrome only LOCAL_STORAGE).
 */
export function ensureVlmHost(): Promise<void> {
  if (!creating) {
    creating = (async () => {
      const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;
      // Older/other browsers without the offscreen API: fail fast with a
      // clear reason so callers report "unavailable" honestly.
      if (!ext?.offscreen?.createDocument) {
        throw new Error('offscreen API unavailable');
      }
      if (ext.offscreen.hasDocument) {
        const has = await ext.offscreen.hasDocument();
        if (has) return;
      }
      let lastErr: unknown = null;
      for (const reasons of OFFSCREEN_REASONS) {
        try {
          await ext.offscreen.createDocument({
            url: OFFSCREEN_PAGE,
            reasons: reasons as any,
            justification: OFFSCREEN_JUSTIFICATION,
          });
          return;
        } catch (e: any) {
          // "An offscreen document with the same url already exists" is a
          // harmless race - treat as success.
          if (String(e?.message ?? e).includes('already exists')) return;
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    })().finally(() => {
      // Clear the cache on BOTH outcomes: a success means the next call
      // re-checks hasDocument (cheap); a failure must not be sticky -
      // retrying a later call can succeed (API restored, doc re-openable).
      creating = null;
    });
  }
  return creating;
}

/** Promise timeout wrapper (the relay has its own; this bounds the SW side too). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface VlmHostReply {
  ok: boolean;
  text?: string;
  boxes?: Array<{ x: number; y: number; width: number; height: number; label: string }>;
  status?: VisionStatus;
  error?: string;
}

/**
 * Send one VLM_HOST_* message to the relay and await its reply. Retries a
 * few times on "Receiving end does not exist" - the relay's onMessage
 * listener takes a beat to register after offscreen.createDocument.
 */
export async function vlmHostSend(msg: Record<string, unknown>, timeoutMs: number): Promise<VlmHostReply> {
  await ensureVlmHost();
  const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await withTimeout(ext.runtime.sendMessage(msg), timeoutMs, String(msg.type));
      if (res && typeof res === 'object' && 'ok' in res) return res as VlmHostReply;
      // The offscreen relay answers every VLM_HOST_* message with {ok,...};
      // anything else means a different listener answered first - retry.
      lastErr = new Error('vlm host: unexpected reply (no listener?)');
    } catch (e) {
      lastErr = e;
      // Only "no receiving end" is retryable (relay still booting).
      if (String((e as any)?.message ?? e).includes('Receiving end does not exist')) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** OCR a captured screenshot (data-URL). 120s covers a warm run; the relay pre-empts with its own timeout. */
export function vlmHostOcr(dataUrl: string, timeoutMs = 120_000): Promise<VlmHostReply> {
  return vlmHostSend({ type: 'VLM_HOST_OCR', dataUrl }, timeoutMs);
}

/** Object-detection grounding of a captured screenshot (optional query). */
export function vlmHostDetect(dataUrl: string, query?: string, timeoutMs = 120_000): Promise<VlmHostReply> {
  return vlmHostSend({ type: 'VLM_HOST_DETECT', dataUrl, query }, timeoutMs);
}

/** Prewarm: load/initialize the model (first call may download ~150MB q4). */
export function vlmHostInit(timeoutMs = 300_000): Promise<VlmHostReply> {
  return vlmHostSend({ type: 'VLM_HOST_INIT' }, timeoutMs);
}

/**
 * Pure pipeline status (state + backend + last-OCR outcome). Null when the
 * host is unreachable (offscreen API missing, doc not openable) - callers
 * report the VLM as unavailable and the deterministic backstop carries on.
 */
export async function vlmHostStatus(timeoutMs = 15_000): Promise<VisionStatus | null> {
  try {
    const res = await vlmHostSend({ type: 'VLM_HOST_STATUS' }, timeoutMs);
    return res.status ?? (res.ok ? { state: 'idle' } : null);
  } catch {
    return null;
  }
}
