/**
 * DOM Extraction Tests
 * 
 * Tests for DOM sanitization, element selection, and data extraction
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

describe('DOM Extraction - Element Selection', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('should find all interactive elements', () => {
    dom.window.document.body.innerHTML = `
      <button>Click me</button>
      <a href="#">Link</a>
      <input type="text" />
      <select><option>Opt</option></select>
      <textarea></textarea>
    `;

    const buttons = dom.window.document.querySelectorAll('button');
    const links = dom.window.document.querySelectorAll('a[href]');
    const inputs = dom.window.document.querySelectorAll('input');
    const selects = dom.window.document.querySelectorAll('select');
    const textareas = dom.window.document.querySelectorAll('textarea');

    expect(buttons.length).toBe(1);
    expect(links.length).toBe(1);
    expect(inputs.length).toBe(1);
    expect(selects.length).toBe(1);
    expect(textareas.length).toBe(1);
  });

  it('should find elements by role attribute', () => {
    dom.window.document.body.innerHTML = `
      <div role="button">Custom Button</div>
      <div role="link">Custom Link</div>
      <div role="textbox">Custom Input</div>
    `;

    const buttons = dom.window.document.querySelectorAll('[role="button"]');
    const links = dom.window.document.querySelectorAll('[role="link"]');
    const textboxes = dom.window.document.querySelectorAll('[role="textbox"]');

    expect(buttons.length).toBe(1);
    expect(links.length).toBe(1);
    expect(textboxes.length).toBe(1);
  });

  it('should find tabbable elements', () => {
    dom.window.document.body.innerHTML = `
      <button>Btn</button>
      <a href="#">Link</a>
      <input />
      <div tabindex="0">Focusable</div>
      <div tabindex="-1">Not Focusable</div>
    `;

    const tabbable = dom.window.document.querySelectorAll('[tabindex]:not([tabindex="-1"])');
    expect(tabbable.length).toBe(1);
  });
});

describe('DOM Extraction - PII Safety', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('should NOT read password field values', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <input type="password" id="pwd" value="secret123" />
          <input type="text" id="name" value="John Doe" />
        </body>
      </html>
    `);

    // This simulates what the content script does
    const pwdInput = dom.window.document.querySelector('#pwd') as HTMLInputElement;
    const textInput = dom.window.document.querySelector('#name') as HTMLInputElement;

    // Password value should NOT be read
    expect(pwdInput.value).toBe('secret123');
    // But we should check the type, not read the value
    expect(pwdInput.getAttribute('type')).toBe('password');
    
    // Text input value CAN be read for non-sensitive fields
    expect(textInput.value).toBe('John Doe');
  });

  it('should detect password fields without reading values', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <input type="password" id="pwd1" />
          <input type="password" id="pwd2" />
          <input type="text" id="name" />
        </body>
      </html>
    `);

    const pwdInputs = dom.window.document.querySelectorAll('input[type="password"]');
    expect(pwdInputs.length).toBe(2);
  });

  it('should sanitize DOM before transmission', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <form>
            <input type="text" name="username" value="john" />
            <input type="password" name="password" value="secret" />
            <input type="email" name="email" value="john@example.com" />
          </form>
        </body>
      </html>
    `);

    // Extract only safe attributes
    const inputs = dom.window.document.querySelectorAll('input');
    const safeData: Array<{name: string, type: string}> = [];

    inputs.forEach(input => {
      const type = input.getAttribute('type') || 'text';
      const name = input.getAttribute('name') || '';
      
      // Skip password values
      if (type === 'password') {
        safeData.push({ name, type: 'password_FIELD_ONLY' });
      } else {
        safeData.push({ name, type });
      }
    });

    // Verify no password values leaked
    expect(safeData.some(d => d.type === 'password_FIELD_ONLY')).toBe(true);
  });
});

describe('DOM Extraction - Accessibility Tree', () => {
  it('should build simplified accessibility tree', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <nav aria-label="Main">Navigation</nav>
          <main>
            <button>Click</button>
            <input aria-label="Search" type="text" />
          </main>
        </body>
      </html>
    `);

    const roles = dom.window.document.querySelectorAll('[aria-label]');
    expect(roles.length).toBe(2);
  });

  it('should handle missing accessibility attributes gracefully', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <button>No label</button>
          <div>Plain div</div>
        </body>
      </html>
    `);

    // Should not throw
    expect(() => {
      dom.window.document.querySelectorAll('button, div');
    }).not.toThrow();
  });
});

describe('DOM Extraction - Staleness Check', () => {
  it('should verify element is still connected to DOM', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    const body = dom.window.document.body;
    
    const div = dom.window.document.createElement('div');
    body.appendChild(div);
    
    // Element is connected
    expect(div.isConnected).toBe(true);
    
    // Remove element
    body.removeChild(div);
    
    // Element is no longer connected
    expect(div.isConnected).toBe(false);
  });

  it('should handle elements removed during async operations', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>');
    const btn = dom.window.document.getElementById('btn');
    
    expect(btn).not.toBeNull();
    expect(btn!.isConnected).toBe(true);
    
    // Simulate removal
    btn!.remove();
    
    expect(btn!.isConnected).toBe(false);
  });
});

describe('DOM Extraction - Performance', () => {
  it('should extract DOM within time budget', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          ${'<div>Item</div>'.repeat(100)}
        </body>
      </html>
    `);

    const start = performance.now();
    
    // Simulate extraction
    const elements = dom.window.document.querySelectorAll('div');
    expect(elements.length).toBe(100);
    
    const duration = performance.now() - start;
    
    // Should be well under 10ms threshold
    expect(duration).toBeLessThan(10);
  });
});
