import React, { useState, useEffect, useRef } from 'react';
import './Popup.css';
import PrivacyLedger from '../components/PrivacyLedger';
import SoMOverlay from '../components/SoMOverlay';
import { somRenderer } from '../lib/vision/som';
import type { BoundingBox } from '../types';

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
  const [showOverlay, setShowOverlay] = useState(false);
  const [boundingBoxes, setBoundingBoxes] = useState<BoundingBox[]>([]);
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
      // Step 1 & 2 & 3: Send to background agent for secure capture and planning
      addLog('Sending task to background agent...');
      const plan = await browser.runtime.sendMessage({
        type: 'CAPTURE_AND_SEND',
        task_description: task,
      });

      if (plan.error) {
        throw new Error(plan.error);
      }

      addLog(`Planner returned action: ${plan.action?.type}`);

      // Execute first action
      if (plan.action) {
        addLog(`Executing: ${plan.action.type}`);
        await browser.runtime.sendMessage({
          type: 'EXECUTE_ACTION',
          action: plan.action,
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

  const toggleOverlay = () => {
    setShowOverlay(!showOverlay);
    if (!showOverlay) {
      addLog('SoM Overlay enabled');
    } else {
      somRenderer.clearMarks();
      addLog('SoM Overlay disabled');
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

        <div className="button-group">
          <button
            className={`start-button ${isRunning ? 'running' : ''}`}
            onClick={handleStart}
            disabled={isRunning || !task}
          >
            {isRunning ? 'Running...' : 'Start Agent'}
          </button>

          <button
            className="overlay-button"
            onClick={toggleOverlay}
            disabled={isRunning}
          >
            {showOverlay ? 'Hide Overlay' : 'Show Overlay'}
          </button>
        </div>

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

        {/* Privacy Ledger Panel */}
        <div className="privacy-ledger-section">
          <h3 className="log-title">Privacy Ledger</h3>
          <div className="privacy-ledger-container">
            <PrivacyLedger />
          </div>
        </div>
      </div>

      <footer className="popup-footer">
        <span>Privacy-first • On-device inference</span>
      </footer>

      {/* SoM Overlay - renders on top of page when visible */}
      {showOverlay && (
        <div ref={overlayRef} className="overlay-container">
          <SoMOverlay
            boxes={boundingBoxes}
            isVisible={showOverlay}
            onSelectBox={(box) => addLog(`Selected box ${box.id}: ${box.label}`)}
          />
        </div>
      )}
    </div>
  );
}

export default Popup;
