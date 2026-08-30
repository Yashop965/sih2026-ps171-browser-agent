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

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      // Ask the content script for the page's interactive elements. It owns
      // the id -> element registry, so the ids we get back are the same ones
      // the executor resolves later.
      addLog('Extracting page elements...');
      const snapshot: any = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT' });

      if (!snapshot?.ok) throw new Error('Content script did not respond');
      const elements = snapshot.elements ?? [];
      addLog(`Found ${elements.length} interactive elements`);

      // Only structural metadata leaves the machine. No values, no HTML.
      addLog('Sending sanitized context to planner...');
      const response = await fetch('http://localhost:8000/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, elements, step: 1 }),
      });

      if (!response.ok) throw new Error(`Planner returned ${response.status}`);

      const plan = await response.json();
      const actions = plan.actions ?? [];
      addLog(`Planner returned ${actions.length} action(s)`);

      if (actions[0]) {
        const action = actions[0];
        addLog(`Executing: ${action.type ?? action.action} on ${action.targetId ?? action.target}`);

        const result: any = await browser.tabs.sendMessage(tab.id, {
          type: 'EXECUTE',
          action,
        });

        if (result?.ok) {
          addLog('Action executed');
          setStep(1);
        } else {
          addLog(`Action failed: ${result?.error ?? 'unknown error'}`);
        }
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