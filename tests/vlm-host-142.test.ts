import { describe, it, expect, vi } from 'vitest';

/**
 * #142: the SW-side offscreen host. The browser API surface is stubbed on
 * globalThis so the lifecycle logic (reason fallback, "already exists" race,
 * create dedupe, no-listener retry + re-ensure after a kill, non-sticky
 * failures, the NEVER-CREATE status path, and close) is testable without a
 * live Chrome. vlmHost caches its create-dedupe promise at module level, so
 * each test gets a FRESH module (vi.resetModules + dynamic import).
 *
 * Protocol pinned here: VLM_HOST_* field names as sent by the SW —
 * {type, dataUrl, query, timeoutMs} in; {ok, text?, boxes?, status?,
 * error?} out. The relay/worker half (classic IIFE + worker bundle) is
 * covered by the live-probe table in issue #142; a relay unit test with a
 * fake Worker is follow-up #150.
 */

type Handler = (msg: any, n: number) => unknown;
interface StubChrome {
  offscreen: {
    hasDocument: () => Promise<boolean>;
    createDocument: (opts: { url: string; reasons: string[]; justification: string }) => Promise<void>;
    closeDocument: () => Promise<void>;
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
        if ((chrome as any).__rejectReasons?.includes(opts.reasons[0])) {
          calls.rejectReason = opts.reasons[0];
          throw new Error(`Invalid offscreen reason: ${opts.reasons[0]}`);
        }
        (chrome as any).__created = true;
      },
      closeDocument: async () => {
        calls.close = Number(calls.close ?? 0) + 1;
        (chrome as any).__hasDoc = false;
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

async function withStub(setup: (chrome: StubChrome, calls: Record<string, number | string>, sentMessages: any[]) => void = () => {}) {
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

  it('a FAILED ensure is not sticky (the .finally cache clear lets a later call retry)', async () => {
    const { mod, calls, chrome } = await withStub((c) => {
      (c as any).__rejectReasons = ['CUSTOM_WORKER', 'LOCAL_STORAGE']; // both rejected
    });
    await expect(mod.ensureVlmHost()).rejects.toThrow();
    expect(calls.create).toBe(2);
    // Simulate recovery: LOCAL_STORAGE now accepted.
    (chrome as any).__rejectReasons = ['CUSTOM_WORKER'];
    await mod.ensureVlmHost();
    expect(calls.create).toBe(4); // retried both reasons again - cache was cleared
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

  it('re-ensures the doc when a KILL hits the no-listener retry path', async () => {
    const { mod, calls, chrome } = await withStub((c) => {
      (c as any).__hasDoc = true;
      (c as any).__handler = (_m: any, n: number) => {
        if (n === 1) {
          // Simulate Chrome killing the offscreen doc mid-flight: the reply
          // channel dies AND the doc is gone, so the re-ensure must re-create.
          (chrome as any).__hasDoc = false;
          const e: any = new Error('Could not establish connection. Receiving end does not exist.');
          return Promise.reject(e);
        }
        return { ok: true, text: 'AFTER-RECREATE', status: { state: 'ready' } };
      };
    });
    const res = await mod.vlmHostOcr('data:image/png;base64,AAA', 5_000);
    expect(res.text).toBe('AFTER-RECREATE');
    expect(calls.create).toBe(1); // the doc was re-created on the retry
  });

  it('reports host unreachable as an honest failed status (never throws to the pill)', async () => {
    const { mod } = await withStub((c) => {
      (c as any).__hasDoc = true;
      (c as any).__handler = () => Promise.reject(new Error('Extension context invalidated'));
    });
    const res = await mod.vlmHostStatus(2_000);
    expect(res).toEqual({ state: 'failed', lastLoadError: 'vlm host unreachable' });
  });

  it('vlmHostOcr forwards the data-URL payload WITH the relay timeout and surfaces the reply', async () => {
    const { mod, sentMessages } = await withStub((c) => {
      (c as any).__hasDoc = true;
      (c as any).__handler = () => ({ ok: true, text: 'HELLO', status: { state: 'ready', backend: 'webgpu' } });
    });
    const res = await mod.vlmHostOcr('data:image/png;base64,AAA', 300_000);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('HELLO');
    // #149 review: the relay gets SW-budget - 1s so its own timer preempts
    // the SW's withTimeout (the old fixed 120s relay timeout killed the
    // 300s cold-download case).
    expect(sentMessages[0]).toEqual({ type: 'VLM_HOST_OCR', dataUrl: 'data:image/png;base64,AAA', timeoutMs: 299_000 });
  });
});

describe('#142 vlmHostStatus — NEVER creates the host (review of #149)', () => {
  it('reports idle without allocating the offscreen doc when it is closed', async () => {
    const { mod, calls } = await withStub((c) => {
      (c as any).__hasDoc = false;
    });
    const res = await mod.vlmHostStatus(2_000);
    expect(res).toEqual({ state: 'idle' });
    expect(calls.create).toBeUndefined(); // no document was opened
    expect(calls.send).toBeUndefined(); // nothing to ask a closed doc
  });
});

describe('#142 closeVlmHost — teardown (review of #149)', () => {
  it('closes an open host document', async () => {
    const { mod, calls } = await withStub((c) => {
      (c as any).__hasDoc = true;
    });
    await mod.closeVlmHost();
    expect(calls.close).toBe(1);
  });

  it('is a no-op when the offscreen API is absent (never throws)', async () => {
    const { mod } = await withStub(() => {});
    delete (globalThis as any).chrome.offscreen.closeDocument; // not supported
    await expect(mod.closeVlmHost()).resolves.toBeUndefined();
  });
});
