/**
 * Unit tests for issue #61 — outbound PII firewall on the live /plan egress.
 *
 * The live agent loop (Popup -> fetch /plan) must route its payload through
 * the same redact -> firewall pipeline the background CAPTURE_AND_SEND path
 * used. `guardOutboundPlan` (src/lib/pii/outboundGuard.ts) is pure, so it is
 * testable in Node with no DOM.
 *
 * Fixtures (validated against src/lib/pii/validators + the recall suite):
 *   - valid PAN   : ABCDE1234P   (matches the PAN regex [A-Z]{5}\d{4}[A-Z])
 *   - Luhn-valid card: 4111111111111111 (CREDIT_CARD validator passes)
 *   - valid email : jo@example.com (EMAIL regex + validator both pass)
 */

import { describe, it, expect } from 'vitest';
import { guardOutboundPlan } from '../src/lib/pii/outboundGuard';

const cleanTask = 'Fill the checkout form';
const cleanElements = [
  { id: 1, tag: 'input', role: 'textbox', label: 'First Name', name: 'fname', isPassword: false },
  { id: 2, tag: 'input', role: 'textbox', label: 'City', name: 'city', isPassword: false },
];
const cleanContext = {
  url: 'https://example.com/checkout',
  title: 'Checkout',
  scrollY: 0,
  scrollHeight: 1800,
  viewport: { width: 800, height: 800 },
  moreContentBelow: true,
};
const cleanHistory = [{ targetId: 1, result: 'OK' }];

describe('guardOutboundPlan', () => {
  it('passes a clean payload through unchanged', () => {
    const result = guardOutboundPlan({
      task: cleanTask,
      elements: cleanElements,
      context: cleanContext,
      history: cleanHistory,
      passThrough: { step: 0, inputCount: 2, buttonCount: 1 },
    });

    expect(result.blocked).toBe(false);
    expect(result.payload.task).toBe(cleanTask);
    expect((result.payload.elements as any[])[0].label).toBe('First Name');
    expect(result.payload.context).toEqual(cleanContext);
    expect(result.payload.history).toEqual(cleanHistory);
    expect(result.payload.step).toBe(0);
    expect(result.payload.inputCount).toBe(2);
    expect(result.redactedCount).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('redacts a PAN embedded in an element label in place (not blocked, already masked)', () => {
    const elements = [
      { id: 1, tag: 'input', role: 'textbox', label: 'Your PAN: ABCDE1234P', name: 'pan', isPassword: false },
    ];
    const result = guardOutboundPlan({ task: cleanTask, elements });

    // The PAN is masked at the element layer, so the firewall gate sees a
    // clean payload and does NOT block.
    expect(result.blocked).toBe(false);
    const label = (result.payload.elements as any[])[0].label;
    expect(label).toContain('[REDACTED]');
    expect(label).not.toContain('ABCDE1234P');
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
    // A redaction event records where + what category, never the value.
    expect(result.events.some((e) => e.selector === 'elements[0].label' && e.type === 'PAN')).toBe(true);
  });

  it('redacts an email embedded in the task string', () => {
    const result = guardOutboundPlan({
      task: 'Enter email jo@example.com into the form',
      elements: [],
    });

    expect(result.blocked).toBe(false);
    const task = result.payload.task as string;
    expect(task).not.toContain('jo@example.com');
    expect(task).toContain('[REDACTED]');
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it('leaves plain non-PII labels, geometry, and history untouched', () => {
    const result = guardOutboundPlan({
      task: cleanTask,
      elements: cleanElements,
      context: cleanContext,
      history: cleanHistory,
    });

    expect(result.blocked).toBe(false);
    const labels = (result.payload.elements as any[]).map((e: any) => e.label);
    expect(labels).toEqual(['First Name', 'City']);
    expect(result.payload.context).toEqual(cleanContext);
    expect(result.redactedCount).toBe(0);
  });

  it('BLOCKS the payload when PII survives into the body (final firewall gate)', () => {
    // context is passed through WITHOUT element-layer redaction (it is
    // geometry in practice, not a PII field). A Luhn-valid card smuggled into
    // a context value must therefore be stopped by the last-line firewall so
    // it never reaches the network.
    const result = guardOutboundPlan({
      task: cleanTask,
      elements: cleanElements,
      context: { notes: 'card 4111111111111111' },
    });

    expect(result.blocked).toBe(true);
    expect(result.category).toBe('CREDIT_CARD');
    expect(result.reason).toBeTruthy();
    // On block we keep the payload intact (the caller MUST NOT transmit it);
    // the guarantee is that blocked===true forces the abort in Popup.
  });

  it('does not block when the only card-like value is in a redacted element label', () => {
    // The element layer masks the card; the firewall then sees clean text.
    const elements = [
      { id: 1, tag: 'input', role: 'textbox', label: 'card 4111111111111111', name: 'cc', isPassword: false },
    ];
    const result = guardOutboundPlan({ task: cleanTask, elements });
    expect(result.blocked).toBe(false);
    const label = (result.payload.elements as any[])[0].label;
    expect(label).toContain('[REDACTED]');
    expect(label).not.toContain('4111111111111111');
  });
});
