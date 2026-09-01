import { useState, useCallback, useEffect } from 'react';
import { browser } from 'wxt/browser';
import './Popup.css';
import PrivacyLedger from '../components/PrivacyLedger';
import ResourceMonitor from '../components/ResourceMonitor';
import { PROVIDERS, ProviderKey, getProvider } from '../lib/providerConfig';

function Popup() {
  const [isRunning, setIsRunning] = useState(false);
  const [task, setTask] = useState('');
  const [step, setStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey>('custom');
  const [providerKey, setProviderKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'checking' | 'healthy' | 'unhealthy'>('checking');
  const [serverLatency, setServerLatency] = useState<number>(0);

  // Load saved provider config from chrome.storage
  useState(() => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(['providerKey', 'apiKey'], (result) => {
        if (result.providerKey) setSelectedProvider(result.providerKey as ProviderKey);
        if (result.apiKey) setProviderKey(result.apiKey);
      });
    }
  });

  // Health check function
  const checkHealth = useCallback(async () => {
    const start = performance.now();
    try {
      const response = await fetch('http://localhost:8000/health', {
        signal: AbortSignal.timeout(3000)
      });
      const latency = Math.round(performance.now() - start);
      setServerLatency(latency);
      setHealthStatus(response.ok ? 'healthy' : 'unhealthy');
    } catch {
      setServerLatency(0);
      setHealthStatus('unhealthy');
    }
  }, []);

  // Check health on mount and periodically
  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 10000); // Check every 10 seconds
    return () => clearInterval(interval);
  }, [checkHealth]);

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
    let consecutiveScrolls = 0;
    let filledIds = new Set<number>(); // Track which element IDs are already filled

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      while (currentStep < maxSteps) {
        currentStep++;
        addLog(`--- Step ${currentStep}/${maxSteps} ---`);
        addLog('Extracting page elements...');

        const snapshot: any = await browser.runtime.sendMessage({ type: 'EXTRACT' });
        console.log('[Popup] EXTRACT response:', snapshot);

        if (!snapshot?.ok) {
          addLog(`Failed to extract elements: ${snapshot?.error ?? 'no ok flag'}`);
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
        // Build history with actually filled element IDs
        const history = Array.from(filledIds).map(id => ({ targetId: id, result: 'OK' }));

        const response = await fetch('http://localhost:8000/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task,
            elements,
            step: currentStep,
            inputCount: inputFields.length,
            buttonCount: buttons.length,
            history: history,
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
          const scrollResult = await browser.runtime.sendMessage({
            type: 'EXECUTE',
            action: { type: 'SCROLL', direction: 'down', amount: 500 }
          });
          if (!scrollResult?.ok) {
            addLog('Scroll failed');
          }
        } else if (action.type === 'TYPE' && action.targetId && action.value) {
          consecutiveScrolls = 0; // Reset scroll counter on successful action
          addLog(`Typing: "${action.value}" into element #${action.targetId}`);
          const result: any = await browser.runtime.sendMessage({
            type: 'EXECUTE',
            action,
          });

          if (result?.ok) {
            addLog('✅ Typed successfully');
            setStep(currentStep);
            filledIds.add(action.targetId); // Track this ID as filled
          } else {
            addLog(`❌ Type failed: ${result?.error ?? 'unknown'}`);
            // Still mark as attempted so planner doesn't retry forever
            filledIds.add(action.targetId);
          }
        } else if (action.type === 'CLICK' && action.targetId) {
          consecutiveScrolls = 0;
          addLog(`Clicking element #${action.targetId}`);
          const result: any = await browser.runtime.sendMessage({
            type: 'EXECUTE',
            action,
          });

          if (result?.ok) {
            addLog('✅ Clicked successfully');
            setStep(currentStep);
            filledIds.add(action.targetId);

            // If we clicked submit, task might be done
            if (action.targetId === buttons[buttons.length - 1]?.id) {
              addLog('🎯 Submit button clicked - task likely complete');
              break;
            }
          } else {
            addLog(`❌ Click failed: ${result?.error ?? 'unknown'}`);
            // Still mark as attempted so planner doesn't retry forever
            filledIds.add(action.targetId);
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
        {/* Status Indicator */}
        <div className="status-indicator" title={healthStatus === 'healthy' ? `Server OK (${serverLatency}ms)` : healthStatus === 'checking' ? 'Checking...' : 'Server Offline'}>
          <span className={`status-dot ${healthStatus === 'healthy' ? 'healthy' : healthStatus === 'checking' ? 'checking' : 'unhealthy'}`}></span>
          <span className="status-text">{healthStatus === 'healthy' ? 'Live' : healthStatus === 'checking' ? 'Check...' : 'Dead'}</span>
          {serverLatency > 0 && <span className="status-latency">{serverLatency}ms</span>}
        </div>
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

        <div className="provider-section">
          <label className="input-label">LLM Provider</label>
          <div className="provider-row">
            <select
              className="provider-select"
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value as ProviderKey)}
            >
              {Object.values(PROVIDERS).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <button className="settings-button" onClick={() => setShowSettings(!showSettings)}>
              ⚙️
            </button>
          </div>
          {showSettings && (
            <div className="provider-settings">
              <input
                type="password"
                className="api-key-input"
                placeholder="Enter API key..."
                value={providerKey}
                onChange={(e) => setProviderKey(e.target.value)}
              />
              <button
                className="save-key-button"
                onClick={() => {
                  if (typeof chrome !== 'undefined' && chrome.storage) {
                    chrome.storage.local.set({ providerKey: selectedProvider, apiKey: providerKey });
                  }
                  setShowSettings(false);
                }}
              >Save</button>
            </div>
          )}
        </div>

        <ResourceMonitor />
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