import { useState } from 'react';
import { browser } from 'wxt/browser';
import './Popup.css';
import PrivacyLedger from '../components/PrivacyLedger';

function Popup() {
  const [isRunning, setIsRunning] = useState(false);
  const [task, setTask] = useState('');
  const [step, setStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);

  const addLog = (message: string) => {
    setLogs(prev =>
      [`${new Date().toLocaleTimeString()}: ${message}`, ...prev].slice(0, 50)
    );
  };

  const handleStart = async () => {
    if (!task) return;
    setIsRunning(true);
    setStep(0);
    setLogs([]);
    setLatency(null);
    addLog(`Starting task: "${task}"`);

    const started = performance.now();
    const maxSteps = 15;
    let currentStep = 0;
    let consecutiveScrolls = 0; // Track scroll spam

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      while (currentStep < maxSteps) {
        currentStep++;
        addLog(`--- Step ${currentStep}/${maxSteps} ---`);
        addLog('Extracting page elements...');

        const snapshot: any = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT' });

        if (!snapshot?.ok) {
          addLog('Failed to extract elements');
          break;
        }

        const elements = snapshot.elements ?? [];
        addLog(`Found ${elements.length} interactive elements`);

        if (elements.length === 0) {
          addLog('No interactive elements found');
          break;
        }

        // Count input fields vs buttons
        const inputFields = elements.filter((e: any) => e.role === 'textbox' || e.tag === 'input');
        const buttons = elements.filter((e: any) => e.role === 'button' || e.tag === 'button');

        addLog(`Elements: ${inputFields.length} inputs, ${buttons.length} buttons`);

        addLog('Sending sanitized context to planner...');
        const response = await fetch('http://localhost:8000/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task,
            elements,
            step: currentStep,
            inputCount: inputFields.length,
            buttonCount: buttons.length,
            history: logs.filter(l => l.includes('Executing:')).map(l => ({
              action: l.replace('Executing: ', '').split(' on ')[0],
              targetId: parseInt(l.split(' on ')[1]) || null,
              result: 'OK'
            }))
          }),
        });

        if (!response.ok) {
          addLog(`Planner error: ${response.status}`);
          break;
        }

        const plan = await response.json();
        const action = plan.action;

        addLog(`Planner returned: ${action?.type ?? 'NONE'}`);

        if (!action || action.type === 'DONE') {
          addLog('✅ Task complete (planner signaled DONE)');
          break;
        }

        if (action.type === 'SCROLL') {
          consecutiveScrolls++;
          if (consecutiveScrolls > 3) {
            addLog('⚠️ Too many scrolls, stopping to prevent loop');
            break;
          }
          addLog(`Scrolling page... (${consecutiveScrolls}/3)`);
          const scrollResult = await browser.tabs.sendMessage(tab.id, {
            type: 'EXECUTE',
            action: { type: 'SCROLL', direction: 'down', amount: 500 }
          });
          if (!scrollResult?.ok) {
            addLog('Scroll failed');
          }
        } else if (action.type === 'TYPE' && action.targetId && action.value) {
          consecutiveScrolls = 0; // Reset scroll counter on successful action
          addLog(`Typing: "${action.value}" into element #${action.targetId}`);
          const result: any = await browser.tabs.sendMessage(tab.id, {
            type: 'EXECUTE',
            action,
          });

          if (result?.ok) {
            addLog('✅ Typed successfully');
            setStep(currentStep);
          } else {
            addLog(`❌ Type failed: ${result?.error ?? 'unknown'}`);
          }
        } else if (action.type === 'CLICK' && action.targetId) {
          consecutiveScrolls = 0;
          addLog(`Clicking element #${action.targetId}`);
          const result: any = await browser.tabs.sendMessage(tab.id, {
            type: 'EXECUTE',
            action,
          });

          if (result?.ok) {
            addLog('✅ Clicked successfully');
            setStep(currentStep);

            // If we clicked submit, task might be done
            if (action.targetId === buttons[buttons.length - 1]?.id) {
              addLog('🎯 Submit button clicked - task likely complete');
              break;
            }
          } else {
            addLog(`❌ Click failed: ${result?.error ?? 'unknown'}`);
          }
        } else {
          addLog(`Unknown action: ${JSON.stringify(action)}`);
          break;
        }

        await new Promise(r => setTimeout(r, 800));
      }

      if (currentStep >= maxSteps) {
        addLog(`⚠️ Reached maximum steps (${maxSteps})`);
      }

      addLog('Task completed');
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLatency(Math.round(performance.now() - started));
      setIsRunning(false);
    }
  };

  return (
    <div className="popup">
      <header className="popup-header">
        <h1 className="popup-title">SIH2026 PS171</h1>
        <p className="popup-subtitle">Browser Agent</p>
      </header>

      <div className="popup-body">
        <div className="task-input-section">
          <label className="input-label">Task Description</label>
          <textarea
            className="task-textarea"
            placeholder="e.g., Fill the form with test data and submit..."
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
          />
        </div>

        <button
          className={`start-button ${isRunning ? 'running' : ''}`}
          onClick={handleStart}
          disabled={isRunning || !task}
        >
          {isRunning ? 'Running...' : 'Start Agent'}
        </button>

        {step > 0 && (
          <div className="step-indicator">Step {step} of task execution</div>
        )}

        {latency !== null && (
          <div className="latency-display">Latency: {latency}ms</div>
        )}

        <div className="log-section">
          <h3 className="log-title">Activity Log</h3>
          <div className="log-container">
            {logs.map((log, i) => (
              <div key={i} className="log-entry">{log}</div>
            ))}
          </div>
        </div>

        <div
          style={{
            height: 300,
            marginTop: 12,
            border: '1px solid #1E242D',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <PrivacyLedger />
        </div>
      </div>

      <footer className="popup-footer">
        <span>Privacy-first • On-device inference</span>
      </footer>
    </div>
  );
}

export default Popup;