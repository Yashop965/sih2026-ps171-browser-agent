import React, { useState, useEffect, useRef } from 'react';
import './Popup.css';

interface SoMBox {
  id: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

function Popup() {
  const [isRunning, setIsRunning] = useState(false);
  const [task, setTask] = useState('');
  const [step, setStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [elements, setElements] = useState<SoMBox[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);

  const addLog = (message: string) => {
    setLogs(prev => [`${new Date().toLocaleTimeString()}: ${message}`, ...prev].slice(0, 50));
  };

  const handleStart = async () => {
    if (!task) return;
    setIsRunning(true);
    setStep(0);
    setLogs([]);
    addLog(`Starting task: "${task}"`);

    try {
      // Step 1: Capture screenshot
      addLog('Capturing screenshot...');
      const screenshot = await browser.tabs.captureVisibleTab();
      addLog('Screenshot captured');

      // Step 2: Extract DOM elements
      addLog('Extracting DOM elements...');
      const result = await browser.tabs.executeScript({
        code: `
          const elements = [];
          document.querySelectorAll('button, input, select, textarea, a[href]').forEach((el, i) => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              elements.push({
                id: i + 1,
                role: el.tagName.toLowerCase(),
                label: el.getAttribute('aria-label') || el.textContent?.trim() || '',
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              });
            }
          });
          JSON.stringify(elements);
        `,
      });

      const domElements: SoMBox[] = JSON.parse(result[0] || '[]');
      setElements(domElements);
      addLog(`Found ${domElements.length} interactive elements`);

      // Step 3: Send to planner
      addLog('Sending to planner...');
      const response = await fetch('http://localhost:8000/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          elements: domElements,
          step: 1,
        }),
      });

      const plan = await response.json();
      addLog(`Planner returned ${plan.actions.length} actions`);

      // Execute first action
      if (plan.actions[0]) {
        const action = plan.actions[0];
        addLog(`Executing: ${action.action} ${action.target}`);
        await browser.tabs.executeScript({
          code: `
            const el = document.querySelector('${action.target}');
            if (el) {
              ${action.action === 'click' ? 'el.click()' : `el.value = '${action.value}'`}
            }
          `,
        });
        setStep(1);
      }

      addLog('Task completed successfully!');
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="popup">
      <header className="popup-header">
        <h1 className="popup-title">🤖 SIH2026 PS171</h1>
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
          <div className="step-indicator">
            Step {step} of task execution
          </div>
        )}

        {latency !== null && (
          <div className="latency-display">
            Latency: {latency}ms
          </div>
        )}

        <div className="log-section">
          <h3 className="log-title">Activity Log</h3>
          <div className="log-container">
            {logs.map((log, i) => (
              <div key={i} className="log-entry">{log}</div>
            ))}
          </div>
        </div>
      </div>

      <footer className="popup-footer">
        <span>Privacy-first • On-device inference</span>
      </footer>
    </div>
  );
}

export default Popup;
