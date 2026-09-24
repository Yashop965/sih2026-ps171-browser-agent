import { describe, it, expect } from 'vitest';
import {
  isOutboundDomain,
  classifySendVerb,
  classifyOutboundSend,
  stageOutbound,
  elementLabel,
  type OutboundActionLike,
  type ElementLike,
} from '../src/lib/outboundGate';
import { normalizeDomains } from '../src/lib/outboundAllowlist';

// ─── outboundGate: the pure PII-safe classifier ────────────────────────────
describe('#143 outboundGate — domain + verb classification', () => {
  it('isOutboundDomain matches host + subdomain, case-insensitive', () => {
    const allow = ['web.whatsapp.com'];
    expect(isOutboundDomain('https://web.whatsapp.com/chat/1', allow)).toBe(true);
    expect(isOutboundDomain('https://sub.web.whatsapp.com/', allow)).toBe(true);
    expect(isOutboundDomain('https://web.whatsapp.com', allow)).toBe(true);
    // A different domain that merely contains the string is NOT a match.
    expect(isOutboundDomain('https://evil-web.whatsapp.com.evil.io/', allow)).toBe(false);
    expect(isOutboundDomain('https://web.whatsapp.com', [] as string[])).toBe(false);
    expect(isOutboundDomain('https://web.whatsapp.com', undefined)).toBe(false);
    expect(isOutboundDomain(undefined, allow)).toBe(false);
  });

  it('classifySendVerb matches a Send-labeled control on CLICK', () => {
    const els: ElementLike[] = [{ id: 1, label: 'Send', role: 'button' }];
    expect(classifySendVerb({ type: 'CLICK', targetId: 1 }, els)).toBe('send');
  });

  it('classifySendVerb matches an Enter press on a send-labeled control', () => {
    const els: ElementLike[] = [{ id: 4, label: 'Send message' }];
    // "send" is a substring of "Send message" and is the first verb in
    // SEND_VERBS, so the classifier reports "send".
    expect(classifySendVerb({ type: 'KEY', key: 'Enter', targetId: 4 }, els)).toBe('send');
  });

  it('classifySendVerb is null for a plain TYPE into a chat composer', () => {
    // Typing into a composer is staging, not the final send.
    const els: ElementLike[] = [{ id: 2, label: 'Type a message' }];
    expect(classifySendVerb({ type: 'TYPE', targetId: 2, value: 'hi' }, els)).toBeNull();
  });

  it('classifyOutboundSend is OFF without an allowlist (zero change)', () => {
    const els: ElementLike[] = [{ id: 1, label: 'Send', role: 'button' }];
    const hit = classifyOutboundSend({ type: 'CLICK', targetId: 1 }, 'https://web.whatsapp.com/', els, []);
    expect(hit.gated).toBe(false);
    expect(hit.reason).toBe('not-an-outbound-domain');
  });

  it('classifyOutboundSend GATES a send-verb click on an outbound domain', () => {
    const els: ElementLike[] = [{ id: 1, label: 'Send', role: 'button' }];
    const hit = classifyOutboundSend(
      { type: 'CLICK', targetId: 1 },
      'https://web.whatsapp.com/chat/1',
      els,
      ['web.whatsapp.com'],
    );
    expect(hit.gated).toBe(true);
    expect(hit.reason).toBe('send-verb:send');
    expect(hit.elementLabel).toBe('Send');
  });

  it('classifyOutboundSend does NOT gate a safe non-send action on the domain', () => {
    // A clearly navigational link on an outbound domain is not the send.
    const els: ElementLike[] = [{ id: 9, label: 'Profile', role: 'link', tag: 'a' }];
    const hit = classifyOutboundSend(
      { type: 'CLICK', targetId: 9 },
      'https://web.whatsapp.com/',
      els,
      ['web.whatsapp.com'],
    );
    expect(hit.gated).toBe(false);
    expect(hit.reason).toBe('safe-action-on-outbound-domain');
  });

  it('classifyOutboundSend fails CLOSED on an unlabelled click on the domain', () => {
    // An unlabelled control (e.g. a paper-plane icon button) that we cannot
    // prove is a link is treated as a possible send and gated.
    const els: ElementLike[] = [{ id: 7, role: 'button' }];
    const hit = classifyOutboundSend(
      { type: 'CLICK', targetId: 7 },
      'https://web.whatsapp.com/chat/1',
      els,
      ['web.whatsapp.com'],
    );
    expect(hit.gated).toBe(true);
    expect(hit.reason).toBe('fail-closed:unproven-send-on-outbound');
  });

  it('stageOutbound carries the resolved value for display (never to the LLM)', () => {
    const hit = { gated: true, reason: 'send-verb:send', elementLabel: 'Send' };
    const staged = stageOutbound(hit, { type: 'CLICK', targetId: 1 }, 'https://web.whatsapp.com/chat/1', 'WhatsApp', 'resolved payload');
    expect(staged.destinationTitle).toBe('WhatsApp');
    expect(staged.elementLabel).toBe('Send');
    expect(staged.value).toBe('resolved payload');
  });

  it('elementLabel falls back through label -> text -> ariaLabel -> role', () => {
    expect(elementLabel({ label: 'Send' })).toBe('Send');
    expect(elementLabel({ text: 'Paper plane' })).toBe('Paper plane');
    expect(elementLabel({ ariaLabel: 'Attach' })).toBe('Attach');
    expect(elementLabel({ role: 'button' })).toBe('button');
    expect(elementLabel(undefined)).toBe('');
  });
});

// ─── outboundAllowlist: normalisation ───────────────────────────────────────
describe('#143 outboundAllowlist — normalise + dedupe', () => {
  it('trims, lower-cases, strips scheme, dedupes', () => {
    expect(normalizeDomains([' web.whatsapp.com', 'HTTPS://Web.WhatsApp.com/abc', 'web.whatsapp.com'])).toEqual([
      'web.whatsapp.com',
    ]);
  });
  it('drops non-strings and empties', () => {
    expect(normalizeDomains([1, '', '  ', 'docs.google.com'])).toEqual(['docs.google.com']);
  });
  it('returns [] for a non-array (the gate stays off)', () => {
    expect(normalizeDomains('web.whatsapp.com')).toEqual([]);
    expect(normalizeDomains(null)).toEqual([]);
  });
});

// ─── AgentRunner: the gate pauses the run for a human ───────────────────────
import { AgentRunner, type AgentRunnerDeps } from '../src/lib/agentRunner';
import { harvestToHandoff, emptyHandoff } from '../src/lib/tabHandoff';

function runnerSmStub() {
  return {
    startSession: async () => 's',
    getContext: () => null,
    isTaskViable: () => true,
    failSession: () => {},
    completeSession: () => {},
    recordFailedElement: () => {},
  } as any;
}

function makeGateRunner(
  steps: Array<{ plan: { action: OutboundActionLike & Record<string, any> }; executeResults?: Array<Record<string, any>> }>,
  gate: {
    allowlist: () => Promise<string[]>;
    destination: () => Promise<{ url: string; title: string }>;
    onGate: (staged: any) => { confirmed: boolean; dismissed?: boolean; stopRequested?: boolean };
  },
) {
  const executed: Array<Record<string, any>> = [];
  let planIndex = 0;
  const deps = {
    extract: async () => ({
      ok: true,
      elements: [
        { id: 1, tag: 'button', role: 'button', label: 'Send' },
        { id: 2, tag: 'input', role: 'textbox', label: 'msg' },
      ],
      url: 'https://web.whatsapp.com/chat/1',
      title: 'WhatsApp',
      context: null,
    }),
    execute: async (a: any) => {
      executed.push(a);
      const list = steps.find((s) => s.executeResults)?.executeResults ?? [];
      const result = list[planIndex] ?? {};
      return { ok: true, ...result };
    },
    navigate: async () => ({ ok: true }),
    fetchPlan: async () => {
      const step = steps[planIndex++] ?? { plan: { action: { type: 'DONE' } } };
      return step.plan;
    },
    delay: async () => {},
    sessionManager: runnerSmStub(),
    tabId: -1,
    windowId: 1,
    task: 'send the sheet',
    startUrl: '',
    onProgress: () => {},
    isStopped: () => false,
    // The gate. destination returns the outbound tab; onGate is the user's call.
    outboundGate: {
      allowlist: gate.allowlist,
      destination: gate.destination,
      awaitConfirmation: async (staged: any) => gate.onGate(staged),
    },
  };
  const runner = new AgentRunner(deps as unknown as AgentRunnerDeps);
  return { runner, executed };
}

describe('#143 AgentRunner — outbound gate flow', () => {
  it('CONFIRM: executes the gated send exactly once', async () => {
    const allowlist = async () => ['web.whatsapp.com'];
    const destination = async () => ({ url: 'https://web.whatsapp.com/chat/1', title: 'WhatsApp' });
    let gateCalls = 0;
    const { runner, executed } = makeGateRunner(
      [
        { plan: { action: { type: 'CLICK', targetId: 1 } }, executeResults: [{ ok: true }] },
        { plan: { action: { type: 'DONE' } } },
      ],
      {
        allowlist,
        destination,
        onGate: (staged) => {
          gateCalls += 1;
          // The staged payload is the display-only value, with the destination.
          expect(staged.destinationTitle).toBe('WhatsApp');
          return { confirmed: true };
        },
      },
    );
    await runner.run();
    expect(gateCalls).toBe(1);
    // The send CLICK reached the executor.
    expect(executed.some((a) => a.type === 'CLICK' && a.targetId === 1)).toBe(true);
  });

  it('DISMISS: skips the send, does NOT execute it, run ends complete (work preserved)', async () => {
    const { runner, executed } = makeGateRunner(
      [
        { plan: { action: { type: 'CLICK', targetId: 1 } }, executeResults: [{ ok: true }] },
        { plan: { action: { type: 'DONE' } } },
      ],
      {
        allowlist: async () => ['web.whatsapp.com'],
        destination: async () => ({ url: 'u', title: 'WhatsApp' }),
        onGate: () => ({ confirmed: false, dismissed: true }),
      },
    );
    await runner.run();
    // The send never executed; the loop ended before it.
    expect(executed.some((a) => a.type === 'CLICK')).toBe(false);
  });

  it('allowlist OFF (empty): a send click is NOT gated - executes freely', async () => {
    let gateCalled = 0;
    const { runner, executed } = makeGateRunner(
      [
        { plan: { action: { type: 'CLICK', targetId: 1 } }, executeResults: [{ ok: true }] },
        { plan: { action: { type: 'DONE' } } },
      ],
      {
        allowlist: async () => [], // gate off
        destination: async () => ({ url: 'u', title: 't' }),
        onGate: () => {
          gateCalled += 1;
          return { confirmed: true };
        },
      },
    );
    await runner.run();
    expect(gateCalled).toBe(0); // the gate never fired
    expect(executed.some((a) => a.type === 'CLICK' && a.targetId === 1)).toBe(true);
  });

  it('STOP at the gate: the run ends stopped (the loop breaks, not continues)', async () => {
    const { runner, executed } = makeGateRunner(
      [
        { plan: { action: { type: 'CLICK', targetId: 1 } }, executeResults: [{ ok: true }] },
        { plan: { action: { type: 'DONE' } } },
      ],
      {
        allowlist: async () => ['web.whatsapp.com'],
        destination: async () => ({ url: 'u', title: 'WhatsApp' }),
        onGate: () => ({ confirmed: false, stopRequested: true }),
      },
    );
    await runner.run();
    expect(executed.some((a) => a.type === 'CLICK')).toBe(false);
  });
});
