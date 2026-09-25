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
 * Send one VLM_HOST_* message to the relay and await its reply.
 * - `create`: open the offscreen doc when it's closed (work calls do; the
 *   status poll must NOT - a mere popup visit must not allocate the host).
 * - The relay gets `timeoutMs - 1s` so its own timer pre-empts the SW's
 *   withTimeout and replies {ok:false} instead of the call dying raw
 *   (review of #149: the relay's fixed 120s preempted the SW's 300s
 *   cold-download budget, killing the most common real case).
 * - On "Receiving end does not exist" the doc may have been KILLED by
 *   Chrome (memory pressure - it hosts a ~150MB model); re-ensure before
 *   each retry so a killed doc is re-created instead of all 3 retries
 *   hitting a dead listener.
 */
export async function vlmHostSend(
  msg: Record<string, unknown>,
  timeoutMs: number,
  opts: { create?: boolean } = {},
): Promise<VlmHostReply> {
  const create = opts.create ?? true;
  if (create) await ensureVlmHost();
  const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;
  const payload = { ...msg, timeoutMs: Math.max(5_000, timeoutMs - 1_000) };
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create && attempt > 0) await ensureVlmHost(); // re-ensure after a kill
    try {
      const res = await withTimeout(ext.runtime.sendMessage(payload), timeoutMs, String(msg.type));
      if (res && typeof res === 'object' && 'ok' in res) return res as VlmHostReply;
      // The offscreen relay answers every VLM_HOST_* message with {ok,...};
      // anything else means a different context answered first (single
      // listener invariant: only the offscreen doc should handle VLM_HOST_*).
      console.warn('[vlm-host] unexpected reply shadowing the relay - single-listener invariant broken?', res);
      lastErr = new Error('vlm host: unexpected reply (no listener?)');
      break; // retrying a SHADOWED reply won't fix it
    } catch (e) {
      lastErr = e;
      // Only "no receiving end" is retryable (relay booting, or the doc was
      // killed and needs re-creating).
      if (String((e as any)?.message ?? e).includes('Receiving end does not exist')) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** OCR a captured screenshot (data-URL). Default 300s covers the cold first run (~150MB q4 download). */
export function vlmHostOcr(dataUrl: string, timeoutMs = 300_000): Promise<VlmHostReply> {
  return vlmHostSend({ type: 'VLM_HOST_OCR', dataUrl }, timeoutMs, { create: true });
}

/** Object-detection grounding of a captured screenshot (optional query). */
export function vlmHostDetect(dataUrl: string, query?: string, timeoutMs = 300_000): Promise<VlmHostReply> {
  return vlmHostSend({ type: 'VLM_HOST_DETECT', dataUrl, query }, timeoutMs, { create: true });
}

/** Prewarm: load/initialize the model (first call may download ~150MB q4). */
export function vlmHostInit(timeoutMs = 300_000): Promise<VlmHostReply> {
  return vlmHostSend({ type: 'VLM_HOST_INIT' }, timeoutMs, { create: true });
}

/**
 * Pure pipeline status (state + backend + last-OCR outcome).
 * #149 review fix: NEVER creates the offscreen doc - when it's closed the
 * model is by definition idle, so report that honestly instead of
 * allocating a 150MB-model host on a mere popup visit. Only returns the
 * LIVE status when the doc is already open (a task is running / prewarmed).
 */
export async function vlmHostStatus(timeoutMs = 15_000): Promise<VisionStatus> {
  const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;
  if (ext?.offscreen?.hasDocument) {
    const has = await ext.offscreen.hasDocument().catch(() => false);
    if (!has) return { state: 'idle' }; // closed => nothing is loading/ready
  }
  try {
    const res = await vlmHostSend({ type: 'VLM_HOST_STATUS' }, timeoutMs, { create: false });
    return res.status ?? (res.ok ? { state: 'idle' } : { state: 'failed', lastLoadError: res.error ?? 'vlm host error' });
  } catch {
    // Doc open but the relay is dead/unreachable - report honestly.
    return { state: 'failed', lastLoadError: 'vlm host unreachable' };
  }
}

/**
 * Close the offscreen VLM host (review of #149: nothing ever closed it, so
 * a popup visit leaked the doc + lazily-spawned worker for the whole
 * browser session). The service worker calls this when a task RUN ends, so
 * the host lives only while it may be needed. Idempotent + best-effort: a
 * closed/absent doc is a no-op, never an error.
 */
export async function closeVlmHost(): Promise<void> {
  const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;
  if (!ext?.offscreen?.closeDocument) return;
  try {
    await ext.offscreen.closeDocument();
  } catch {
    /* already closed / doc never opened - nothing to do */
  }
}
