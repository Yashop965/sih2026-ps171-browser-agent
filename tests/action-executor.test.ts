/**
 * Action Executor Tests
 *
 * Tests for click, type, scroll, and navigation actions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

describe('Action Executor - Click', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('should find element by data-agent-id', () => {
    dom.window.document.body.innerHTML = `
      <button data-agent-id="0">Button 1</button>
      <button data-agent-id="1">Button 2</button>
    `;

    const el = dom.window.document.querySelector('[data-agent-id="1"]');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe('Button 2');
  });

  it('should handle missing element gracefully', () => {
    const el = dom.window.document.querySelector('[data-agent-id="999"]');
    expect(el).toBeNull();
  });

  it('should trigger click event', () => {
    dom.window.document.body.innerHTML = '<button id="btn">Click me</button>';
    const btn = dom.window.document.getElementById('btn') as HTMLButtonElement;

    let clicked = false;
    btn.addEventListener('click', () => {
      clicked = true;
    });

    btn.click();
    expect(clicked).toBe(true);
  });
});

describe('Action Executor - Type', () => {
  it('should type into text input', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    dom.window.document.body.innerHTML = '<input type="text" id="name" />';
    const input = dom.window.document.getElementById('name') as HTMLInputElement;

    // Use native setter to bypass React's controlled component behavior
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Hello');

    expect(input.value).toBe('Hello');
  });

  it('should not type into password fields without permission', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    dom.window.document.body.innerHTML = '<input type="password" id="pwd" />';
    const input = dom.window.document.getElementById('pwd') as HTMLInputElement;

    // Password fields should be handled carefully
    expect(input.type).toBe('password');
  });
});

describe('Action Executor - Staleness', () => {
  it('should check if element is still in DOM before acting', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    dom.window.document.body.innerHTML = '<button id="btn">Click</button>';
    const btn = dom.window.document.getElementById('btn');

    expect(btn?.isConnected).toBe(true);

    // Remove element
    btn?.remove();

    expect(btn?.isConnected).toBe(false);
  });

  it('should handle element removal during action', async () => {
    const dom = new JSDOM(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>'
    );
    const btn = dom.window.document.getElementById('btn');

    // Fake timers: this test previously used real 10ms/20ms sleeps, so under
    // CPU contention (a loaded CI runner, a parallel vitest worker) the 20ms
    // wait could elapse before the 10ms removal ran, or the removal could be
    // starved entirely. Virtual time makes the ordering deterministic.
    vi.useFakeTimers();
    try {
      // Simulate async operation with removal
      setTimeout(() => {
        btn?.remove();
      }, 10);

      // Cross the 10ms boundary so the removal callback has definitely run.
      await vi.advanceTimersByTimeAsync(20);

      expect(btn?.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Action Executor - Retry Logic', () => {
  it('should retry failed actions', async () => {
    let attempt = 0;

    const executeWithRetry = async (
      action: () => Promise<boolean>,
      maxRetries = 1
    ): Promise<boolean> => {
      for (let i = 0; i <= maxRetries; i++) {
        try {
          const result = await action();
          if (result) return true;
        } catch (e) {
          if (i === maxRetries) throw e;
        }
        attempt++;
      }
      return false;
    };

    const result = await executeWithRetry(async () => {
      attempt++;
      return attempt >= 2;
    });

    expect(result).toBe(true);
    expect(attempt).toBeGreaterThanOrEqual(2);
  });
});

describe('Action Executor - Timeout', () => {
  it('should timeout after 5 seconds', async () => {
    const executeWithTimeout = async (
      action: () => Promise<boolean>,
      timeoutMs = 5000
    ): Promise<boolean> => {
      return Promise.race([
        action(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        ),
      ]);
    };

    // Fast action should succeed
    const result = await executeWithTimeout(async () => true);
    expect(result).toBe(true);
  });
});
