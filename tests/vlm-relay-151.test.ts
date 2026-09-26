import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * #151 (follow-up of #142/#149): the RELAY half of the VLM offscreen host,
 * unit-testable with a fake Worker. The relay (src/public/vlm/vlm-host-relay.js)
 * is a classic IIFE that (a) reads `globalThis.chrome`, (b) lazily `new
 * Worker`s the module bundle, (c) bridges SW `VLM_HOST_*` messages to worker
 * `type`s, and (d) ships the timeout over the wire. None of it needs a live
 * Chrome — a fake `Worker` + fake `chrome.runtime` is enough.
 *
 * This closes the gap the #149/#152 reviews flagged: vlm-host-142.test.ts pins
 * the SW-side names; this pins the relay->worker field names + the
 * timeout / spawn-fail / crash-respawn / pending-cleanup invariants.
 */

const RELAY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/public/vlm/vlm-host-relay.js',
);
const RELAY_SRC = readFileSync(RELAY, 'utf8');

type Handler = (msg: any, sender: any, sendResponse: (r: any) => void) => unknown;

/** A recording stand-in for the Web `Worker`. */
class FakeWorker {
  url: string;
  opts: { type: string };
  onmessage: ((ev: { data: any }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  postMessageCalls: any[] = [];
  constructor(url: string, opts: { type: string }, throws: string | null) {
    if (throws) throw new Error(throws);
    this.url = url;
    this.opts = opts;
  }
  postMessage(msg: any) {
    this.postMessageCalls.push(msg);
  }
}

function makeChrome() {
  const listeners: Handler[] = [];
  const instances: FakeWorker[] = [];
  let throws: string | null = null;
  const chrome: any = {
    runtime: {
      getURL: (p: string) => `chrome-extension://fake/${p}`,
      onMessage: {
        addListener: (fn: Handler) => { listeners.push(fn); },
        removeListener: () => {},
      },
    },
  };
  class TrackedWorker extends FakeWorker {
    constructor(url: string, opts: { type: string }) {
      super(url, opts, throws);
      instances.push(this);
    }
  }
  return {
    /** Run the relay IIFE once against the current globals. */
    install() {
      globalThis.chrome = chrome;
      globalThis.browser = undefined;
      globalThis.Worker = TrackedWorker as any;
      new Function(RELAY_SRC)();
    },
    setThrows(m: string | null) { throws = m; },
    instances,
    listenerCount() { return listeners.length; },
    /** Drive a VLM_HOST_* msg through the relay; resolves sendResponse. */
    send(msg: any): Promise<any> {
      return new Promise((res) => {
        const r = listeners[0]?.(msg, {}, res);
        if (r === true) return; // async channel held; resolved later via res()
        res(r === undefined ? { __noReply: true } : r);
      });
    },
  };
}

afterEach(() => {
  delete (globalThis as any).chrome;
  delete (globalThis as any).Worker;
  vi.useRealTimers();
});

/** The PII-safe wire contract: only a data-URL + query go out; only box
 *  coords / text / a status object come back. One row per SW type. */
const MAPPING: Array<[swType: string, input: Record<string, unknown>, expected: Record<string, unknown>]> = [
  ['VLM_HOST_INIT', {}, { type: 'INIT' }],
  ['VLM_HOST_OCR', { dataUrl: 'D' }, { type: 'OCR', dataUrl: 'D' }],
  ['VLM_HOST_DETECT', { dataUrl: 'D', query: 'Q' }, { type: 'DETECT', dataUrl: 'D', query: 'Q' }],
  ['VLM_HOST_GROUND', { dataUrl: 'D', query: 'Q' }, { type: 'GROUND', dataUrl: 'D', query: 'Q' }],
  ['VLM_HOST_CAPTION', { dataUrl: 'D' }, { type: 'CAPTION', dataUrl: 'D' }],
  ['VLM_HOST_VQA', { dataUrl: 'D', query: 'Q' }, { type: 'VQA', dataUrl: 'D', query: 'Q' }],
  ['VLM_HOST_STATUS', {}, { type: 'STATUS' }],
];

describe('#151 relay protocol (fake Worker)', () => {
  it('bridges every VLM_HOST_* to the correct worker payload + id, module URL', async () => {
    for (const [swType, input, expected] of MAPPING) {
      const api = makeChrome();
      api.install();
      expect(api.listenerCount()).toBe(1);
      const p = api.send({ type: swType, ...input });
      const w = api.instances[0];
      expect(w).toBeDefined();
      expect(w.url).toBe('chrome-extension://fake/vlm-host-worker.js');
      expect(w.opts).toEqual({ type: 'module' });
      // postMessage happens synchronously inside the promise executor.
      expect(w.postMessageCalls).toHaveLength(1);
      expect(w.postMessageCalls[0]).toEqual({ id: 1, ...expected });
      w.onmessage!({ data: { id: 1, ok: true } });
      await expect(p).resolves.toEqual({ id: 1, ok: true });
    }
  });

  it('honors the on-the-wire timeoutMs (a fast reply wins the race)', async () => {
    vi.useFakeTimers();
    const api = makeChrome();
    api.install();
    const p = api.send({ type: 'VLM_HOST_GROUND', dataUrl: 'D', query: 'Q', timeoutMs: 50 });
    const w = api.instances[0];
    vi.advanceTimersByTime(40); // 10ms under the deadline
    w.onmessage!({ data: { id: 1, ok: true, text: 'won-the-race' } });
    await expect(p).resolves.toEqual({ id: 1, ok: true, text: 'won-the-race' });
    expect(w.postMessageCalls).toHaveLength(1);
  });

  it('times out when no reply arrives within the wire budget', async () => {
    vi.useFakeTimers();
    const api = makeChrome();
    api.install();
    const p = api.send({ type: 'VLM_HOST_STATUS', timeoutMs: 50 });
    vi.advanceTimersByTime(50); // cross the deadline
    await expect(p).resolves.toEqual({ ok: false, error: 'vlm host timeout' });
  });

  it('uses the 15s default for STATUS when no timeoutMs is sent', async () => {
    vi.useFakeTimers();
    const api = makeChrome();
    api.install();
    let settled = false;
    const p = api.send({ type: 'VLM_HOST_STATUS' });
    p.then(() => { settled = true; });
    vi.advanceTimersByTime(14_999);
    expect(settled).toBe(false); // still pending under the 15000ms deadline
    vi.advanceTimersByTime(1); // cross 15000
    await p;
    expect(settled).toBe(true);
  });

  it('fails FAST + honest when the Worker constructor throws (no 300s wait)', async () => {
    // #149 review: a CSP refusal / missing file must not masquerade as a
    // long "vlm host timeout" — it resolves immediately with spawn-failed.
    const api = makeChrome();
    api.setThrows('instantiate failed: CSP');
    api.install();
    const p = api.send({ type: 'VLM_HOST_OCR', dataUrl: 'D' });
    await expect(p).resolves.toEqual({ ok: false, error: 'vlm worker spawn failed: instantiate failed: CSP' });
    expect(api.instances.length).toBe(0); // no worker was created
  });

  it('fails the pending queue + respawns a fresh worker on a crash', async () => {
    const api = makeChrome();
    api.install();
    const p = api.send({ type: 'VLM_HOST_OCR', dataUrl: 'D' }); // worker id 1
    const w = api.instances[0];
    w.onerror!({ message: 'ort wasm aborted' });
    await expect(p).resolves.toEqual({ ok: false, error: 'vlm worker crashed: ort wasm aborted' });
    // A subsequent call respawns a NEW worker; the seq continues, so id is 2.
    const p2 = api.send({ type: 'VLM_HOST_STATUS' });
    expect(api.instances.length).toBe(2);
    api.instances[1].onmessage!({ data: { id: 2, ok: true, status: { ready: false } } });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it('ignores non-VLM messages (does not hold the channel, spawns no worker)', async () => {
    const api = makeChrome();
    api.install();
    const r = await api.send({ type: 'NOT_OURS' });
    expect(r).toEqual({ __noReply: true });
    expect(api.instances.length).toBe(0); // no worker spawned for foreign msgs
  });

  it('no-ops entirely when chrome is absent (content-script host guard)', () => {
    const api = makeChrome();
    globalThis.chrome = undefined;
    globalThis.browser = undefined;
    globalThis.Worker = FakeWorker as any;
    new Function(RELAY_SRC)();
    expect(api.listenerCount()).toBe(0);
  });
});
