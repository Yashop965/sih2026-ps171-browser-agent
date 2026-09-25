import { describe, it, expect, vi } from 'vitest';

/**
 * #142: the SW-side offscreen host. The browser API surface is stubbed on
 * globalThis so the lifecycle logic (reason fallback, "already exists" race,
 * create dedupe, no-listener retry, honest unavailability) is testable
 * without a live Chrome. vlmHost caches its create-dedupe promise at module
 * level, so each test gets a FRESH module (vi.resetModules + dynamic import).
 */

type Handler = (msg: any, n: number) => unknown;
interface StubChrome {
  offscreen: {
    hasDocument: () => Promise<boolean>;
    createDocument: (opts: { url: string; reasons: string[]; justification: string }) => Promise<void>;
  };
  runtime: {
    sendMessage: Handler;
    getURL: (p: string) => string;
  };
}

function makeStub(): { chrome: StubChrome; calls: Record<string, number | string>; sentMessages: any[] } {
  const calls: Record<string, number | string> = {};
  const sentMessages: any[] = [];
  const chrome: StubChrome = {
    offscreen: {
      hasDocument: async () => {
        calls.hasDocument = Number(calls.hasDocument ?? 0) + 1;
        return (chrome as any).__hasDoc ?? false;
      },
      createDocument: async (opts) => {
        calls.create = Number(calls.create ?? 0) + 1;
        calls.lastReason = opts.reasons.join(',');
        (chrome as any).__created = true;
        if ((chrome as any).__rejectReasons?.includes(opts.reasons[0])) {
          calls.rejectReason = opts.reasons[0];
          throw new Error(`Invalid offscreen reason: ${opts.reasons[0]}`);
        }
      },
    },
    runtime: {
      sendMessage: async (msg) => {
        calls.send = Number(calls.send ?? 0) + 1;
        sentMessages.push(msg);
        return (chrome as any).__handler ? (chrome as any).__handler(msg, Number(calls.send)) : { ok: true };
      },
      getURL: (p: string) => `chrome-extension://stub/${p}`,
    },
  };
  return { chrome, calls, sentMessages };
}

async function withStub(setup: (c: StubChrome, calls: Record<string, any>, sent: any[]) => void) {
  const { chrome, calls, sentMessages } = makeStub();
  setup(chrome, calls, sentMessages);
  (globalThis as any).chrome = chrome;
  (globalThis as any).browser = undefined;
  vi.resetModules();
  const mod = await import('../src/lib/vlmHost');
  return { mod, calls, sentMessages, chrome };
}

describe('#142 ensureVlmHost — offscreen doc lifecycle', () => {
  it('short-circuits when a document already exists', async () => {
    const { mod, calls } = await withStub((c) => {
      (c as any).__hasDoc = true;
    });
    await mod.ensureVlmHost();
    expect(calls.hasDocument).toBe(1);
    expect(calls.create).toBeUndefined();
  });

  it('tries the honest reason first, falling back to a stable one', async () => {
    const { mod, calls } = await withStub((c) => {
      (c as any).__rejectReasons = ['CUSTOM_WORKER']; // older Chrome rejects it
    });
    await mod.ensureVlmHost();
    expect(calls.create).toBe(2); // CUSTOM_WORKER rejected, LOCAL_STORAGE succeeded
    expect(calls.rejectReason).toBe('CUSTOM_WORKER');
    expect(calls.lastReason).toBe('LOCAL_STORAGE');
  });

  it('treats an "already exists" race as success (no throw)', async () => {
    const { mod, calls, chrome } = await withStub(() => {});
    chrome.offscreen.createDocument = async (opts) => {
      calls.create = Number(calls.create ?? 0) + 1;
      calls.lastReason = opts.reasons.join(',');
      throw new Error('An offscreen document with the same url already exists');
    };
    await expect(mod.ensureVlmHost()).resolves.toBeUndefined();
    expect(calls.create).toBe(1);
  });

  it('concurrent calls share one creation (dedupe)', async () => {
    const { mod, calls, chrome } = await withStub(() => {});
    let release!: () => void;
    let n = 0;
    chrome.offscreen.createDocument = () => {
      n += 1;
      calls.create = n;
      return new Promise<void>((r) => (release = r));
    };
    const p1 = mod.ensureVlmHost();
    const p2 = mod.ensureVlmHost();
    // The first call's async IIFE suspends at `await hasDocument()` before
    // reaching createDocument - let it progress so `release` is assigned.
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof release).toBe('function'); // reached createDocument
    release();
    await Promise.all([p1, p2]);
    expect(calls.create).toBe(1); // the second call reused the first's promise
  });
});

describe('#142 vlmHostSend — relay protocol', () => {
  it('retries a "Receiving end does not exist" send until the relay answers', async () => {
    const { mod, calls, sentMessages } = await withStub((c) => {
      (c as any).__hasDoc = true;
      (c as any).__handler = (_msg: any, n: number) => {
        if (n === 1) {
          const e: any = new Error('Could not establish connection. Receiving end does not exist.');
          return Promise.reject(e);
        }
        return { ok: true, status: { state: 'idle' } };
      };
    });
    const res = await mod.vlmHostStatus(15_000);
    expect(calls.send).toBe(2);
    expect(sentMessages[0].type).toBe('VLM_HOST_STATUS');
    expect(res?.state).toBe('idle');
  });

  it('reports host unreachable as null status (never throws to the pill)', async () => {
    const { mod } = await withStub((c) => {
      (c as any).__hasDoc = true;
      (c as any).__handler = () => Promise.reject(new Error('Extension context invalidated'));
    });
    expect(await mod.vlmHostStatus(2_000)).toBeNull();
  });

  it('vlmHostOcr forwards the data-URL payload and surfaces the reply', async () => {
    const { mod, sentMessages } = await withStub((c) => {
      (c as any).__hasDoc = true;
      (c as any).__handler = () => ({ ok: true, text: 'HELLO', status: { state: 'ready', backend: 'webgpu' } });
    });
    const res = await mod.vlmHostOcr('data:image/png;base64,AAA', 5_000);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('HELLO');
    expect(sentMessages[0]).toEqual({ type: 'VLM_HOST_OCR', dataUrl: 'data:image/png;base64,AAA' });
  });
});
