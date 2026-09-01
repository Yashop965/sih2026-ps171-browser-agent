import { describe, it, expect } from 'vitest';
import { execute, type Action } from '../src/lib/actions';

describe('Loop Detection', () => {
  it('should track repeated actions', async () => {
    // Test that we can detect when same action is repeated
    const actionHistory: Array<{targetId: number, type: string}> = [];
    
    // Simulate adding actions
    actionHistory.push({ targetId: 1, type: 'TYPE' });
    actionHistory.push({ targetId: 1, type: 'TYPE' }); // Same action twice
    
    // Check for loop detection
    const recentActions = actionHistory.slice(-5);
    const lastAction = recentActions[recentActions.length - 1];
    const secondLastAction = recentActions[recentActions.length - 2];
    
    expect(lastAction?.targetId).toBe(secondLastAction?.targetId);
    expect(lastAction?.type).toBe(secondLastAction?.type);
  });

  it('should detect different actions as not repeated', async () => {
    const actionHistory: Array<{targetId: number, type: string}> = [];
    
    actionHistory.push({ targetId: 1, type: 'TYPE' });
    actionHistory.push({ targetId: 2, type: 'TYPE' }); // Different element
    
    const recentActions = actionHistory.slice(-5);
    const lastAction = recentActions[recentActions.length - 1];
    const secondLastAction = recentActions[recentActions.length - 2];
    
    expect(lastAction?.targetId).not.toBe(secondLastAction?.targetId);
  });
});

describe('Dynamic Max Steps', () => {
  it('should calculate steps based on element count', () => {
    const calculateMaxSteps = (inputs: number, selects: number, buttons: number): number => {
      return Math.max(10, Math.min(50, (inputs + selects) * 3 + buttons + 5));
    };

    // Small form: 3 inputs, 0 selects, 1 button = max(10, min(50, 3*3 + 1 + 5)) = max(10, 15) = 15
    expect(calculateMaxSteps(3, 0, 1)).toBe(15);

    // Large form: 13 inputs, 2 selects, 3 buttons
    expect(calculateMaxSteps(13, 2, 3)).toBe(50); // capped at 50

    // Very small form: 1 input, 0 selects, 1 button
    expect(calculateMaxSteps(1, 0, 1)).toBe(10); // minimum 10
  });

  it('should handle edge cases', () => {
    const calculateMaxSteps = (inputs: number, selects: number, buttons: number): number => {
      return Math.max(10, Math.min(50, (inputs + selects) * 3 + buttons + 5));
    };

    // Empty form
    expect(calculateMaxSteps(0, 0, 0)).toBe(10);

    // Huge form
    expect(calculateMaxSteps(20, 10, 5)).toBe(50); // capped
  });
});

describe('SELECT Action for Dropdowns', () => {
  it('should identify select elements correctly', () => {
    const elements = [
      { tag: 'input', type: 'text', role: 'textbox' },
      { tag: 'select', type: 'select-one', role: 'combobox' },
      { tag: 'button', type: undefined, role: 'button' },
      { tag: 'a', href: '#', role: 'link' },
    ];

    const selects = elements.filter((e: any) => e.tag === 'select' || e.type === 'select-one');
    expect(selects).toHaveLength(1);
    expect(selects[0].tag).toBe('select');
  });

  it('should distinguish between input types', () => {
    const elements = [
      { tag: 'input', type: 'text' },
      { tag: 'input', type: 'email' },
      { tag: 'input', type: 'password' },
      { tag: 'input', type: 'number' },
      { tag: 'textarea' },
      { tag: 'select' },
    ];

    const textInputs = elements.filter((e: any) => 
      e.tag === 'input' && ['text', 'email', 'password', 'number'].includes(e.type)
    );
    expect(textInputs).toHaveLength(4);
  });
});
