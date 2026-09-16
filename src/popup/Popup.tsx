import { useState, useCallback, useEffect, useRef } from 'react';
import { browser } from 'wxt/browser';
import './Popup.css';
import PrivacyLedger from '../components/PrivacyLedger';
import ResourceMonitor from '../components/ResourceMonitor';
import { PROVIDERS, ProviderKey, getProvider } from '../lib/providerConfig';
import { guardOutboundPlan } from '../lib/pii/outboundGuard';

function Popup() {
  const [isRunning, setIsRunning] = useState(false);
  const [task, setTask] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [step, setStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey>('custom');
  const [providerKey, setProviderKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'checking' | 'healthy' | 'unhealthy'>('checking');
  const [serverLatency, setServerLatency] = useState<number>(0);
  const [logsCollapsed, setLogsCollapsed] = useState(false);

  // Issue #70: stop affordance. A ref (not state) so the running loop sees the
  // flag on every iteration without re-rendering the whole popup. Toggled by
  // the Stop button while a task is in flight.
  const stopRequested = useRef(false);

  // Load saved state from browser.storage
  useEffect(() => {
    browser.storage.local.get(['task', 'startUrl', 'providerKey', 'apiKey']).then((result) => {
      if (result.task) setTask(result.task);
      if (result.startUrl) setStartUrl(result.startUrl);
      if (result.providerKey) setSelectedProvider(result.providerKey as ProviderKey);
      if (result.apiKey) setProviderKey(result.apiKey);
    });
  }, []);

  // Save task to browser.storage whenever it changes
  useEffect(() => {
    if (task) {
      browser.storage.local.set({ task });
    }
  }, [task]);

  // Save start URL to browser.storage whenever it changes (multi-page tasks
  // need a starting point; empty means "run on the current tab").
  useEffect(() => {
    if (startUrl) {
      browser.storage.local.set({ startUrl });
    }
  }, [startUrl]);

  // Health check function
  const checkHealth = useCallback(async () => {
    const start = performance.now();
    try {
      const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';
      const response = await fetch(`${serverUrl}/health`, {
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
    stopRequested.current = false; // issue #70: fresh run, clear any prior stop
    setIsRunning(true);
    setStep(0);
    setLogs([]);
    setLatency(null);
    addLog(`Starting task: "${task}"`);

    // Issue #70: an abort signal so a pending /plan fetch can be cancelled
    // the moment Stop is pressed (in addition to the loop-level stop check).
    const abortController = new AbortController();

    const started = performance.now();
    let currentStep = 0;
    let consecutiveScrolls = 0;
    let filledIds = new Set<string>(); // Element IDs successfully filled/acted on
    let failedIds = new Set<string>(); // Tried but FAILED (issue #63) - retryable, NOT "filled"
    const failedErrors = new Map<string, string>(); // Per-ID last failure reason, sent to the planner
    let plannerDegraded = false; // True if the planner reported a degraded run (#68)
    let maxSteps = 15; // Will be updated after first extraction
    let recentActionHistory: Array<{targetId: string, type: string}> = []; // Track recent actions for loop detection

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      // Multi-page autonomy: if the task specifies a starting URL, navigate
      // there first (and wait for load) so the agent begins at the right page
      // instead of whatever happens to be open. Empty startUrl = run on the
      // current tab. Reuses the background NAVIGATE_TAB handler.
      if (startUrl.trim()) {
        addLog(`Starting at ${startUrl}`);
        const nav = await browser.runtime.sendMessage({
          type: 'NAVIGATE_TAB',
          url: startUrl.trim(),
        });
        if (nav?.ok) {
          addLog('✅ Navigated to start URL');
          await new Promise((r) => setTimeout(r, 600)); // hydration settle
        } else {
          addLog(`⚠️ Could not navigate to start URL (${nav?.error ?? 'unknown'}) - running on current tab`);
        }
      }

      while (currentStep < maxSteps) {
        // Issue #70: honor a Stop request at the top of every iteration so a
        // user who pressed Stop (or started the wrong task / a runaway loop)
        // gets the run back immediately.
        if (stopRequested.current) {
          addLog('⏹ Stopped by user');
          break;
        }
        currentStep++;
        addLog(`--- Step ${currentStep}/${maxSteps} ---`);
        addLog('Extracting page elements...');

        const snapshot: any = await browser.runtime.sendMessage({ type: 'EXTRACT' });

        if (!snapshot?.ok) {
          addLog(`Failed to extract elements: ${snapshot?.error ?? 'no ok flag'}`);
          break;
        }

        const elements = snapshot.elements ?? [];
        addLog(`Found ${elements.length} interactive elements`);

        // Where the agent is right now (multi-page autonomy). The background
        // forwards these from capturePage; sending them lets the planner see
        // the current page and issue a meaningful NAVIGATE instead of planning
        // against a blind "http://localhost" default.
        const pageUrl: string = snapshot.url ?? '';
        const pageTitle: string = snapshot.title ?? '';

        // Page geometry + scroll affordance (issue #59). The background now
        // forwards this; forward it on to the planner so it knows whether the
        // form continues below the fold and can decide to scroll.
        const pageContext = snapshot.context ?? null;
        if (pageContext?.moreContentBelow) {
            addLog(`Page has more content below the fold (scrollY=${pageContext.scrollY}/${pageContext.scrollHeight})`);
        }

        if (elements.length === 0) {
          addLog('No interactive elements found');
          break;
        }

        // Count input fields vs buttons
        const inputFields = elements.filter((e: any) => e.role === 'textbox' || e.tag === 'input');
        const buttons = elements.filter((e: any) => e.role === 'button' || e.tag === 'button');
        const selects = elements.filter((e: any) => e.tag === 'select' || e.type === 'select-one');

        addLog(`Elements: ${elements.length} total (${inputFields.length} inputs, ${selects.length} selects, ${buttons.length} buttons)`);

        // Dynamically calculate max steps based on elements found
        // Be generous - need steps for each field + submit
        const totalFields = inputFields.length + selects.length;
        const calculatedMax = Math.max(20, totalFields * 3 + buttons.length + 10);
        if (currentStep === 0 || maxSteps === 15) {
          maxSteps = Math.min(100, calculatedMax); // Cap at 100 but be generous
          addLog(`Calculated max steps: ${maxSteps} (need to fill ${totalFields} fields)`);
        }

        addLog('Sending sanitized context to planner...');
        // Build history. Issue #63: previously every attempted field was
        // reported as result:'OK' (filledIds doubled as success + gave-up), so
        // a FAILED type was sent to the planner as "already filled" and could
        // never be retried. Now successes are OK, failures are FAILED with the
        // error reason so the planner can re-plan / retry a different value.
        const history: Array<{ targetId: string; result: 'OK' | 'FAILED'; error?: string }> = [];
        for (const id of filledIds) history.push({ targetId: id, result: 'OK' });
        for (const id of failedIds) {
          if (filledIds.has(id)) continue; // succeeded on a later retry -> OK only
          history.push({ targetId: id, result: 'FAILED', error: failedErrors.get(id) ?? 'unknown' });
        }

        // Issue #61: the live /plan egress was bypassing the outbound PII
        // firewall (the redact->firewall pipeline lived only in the dead
        // CAPTURE_AND_SEND path). Route it through the shared guard now: it
        // redacts task + element labels/names in place, then runs
        // checkOutboundPayload as a final gate. If blocked, abort - no PII
        // reaches the network.
        const guard = guardOutboundPlan({
          task,
          elements: elements as Record<string, unknown>[],
          context: pageContext ?? undefined,
          history,
          passThrough: { step: currentStep, inputCount: inputFields.length, buttonCount: buttons.length, url: pageUrl, title: pageTitle },
        });
        if (guard.blocked) {
          addLog(`⛔ Outbound firewall blocked /plan egress: ${guard.category ?? 'PII'} at ${guard.reason ?? '?'}`);
          setHealthStatus('unhealthy'); // not really, but surface the block loudly in logs
          break;
        }
        if (guard.redactedCount > 0) {
          addLog(`Masked ${guard.redactedCount} PII field(s) before /plan egress`);
        }

        const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';
        const response = await fetch(`${serverUrl}/plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(guard.payload),
          // Issue #70: cancel the in-flight /plan call the moment Stop is
          // pressed, so the loop doesn't stall on a multi-second request.
          signal: abortController.signal,
        });

        if (!response.ok) {
          addLog(`Planner error: ${response.status}`);
          break;
        }

        const plan = await response.json();
        const action = plan.action;

        // Issue #68: the planner may be degraded (no LLM reachable at init, or
        // a heuristic fallback after a runtime LLM error). Track it so we do
        // not report a mock/heuristic DONE as a genuine task completion.
        if (plan.degraded) {
          addLog(`⚠️ Planner degraded: ${plan.degraded_reason ?? 'no LLM reachable'}`);
        }

        addLog(`Planner returned: ${action?.type ?? 'NONE'}`);

        if (!action || action.type === 'DONE') {
          if (plan.degraded) {
            addLog('⚠️ Stopping: planner signaled DONE while DEGRADED (no LLM / heuristic) — task NOT genuinely complete');
            plannerDegraded = true;
          } else {
            addLog('✅ Task complete (planner signaled DONE)');
          }
          break;
        }

        // Track recent actions to detect loops - CHECK AFTER action is declared
        const recentActions = recentActionHistory.slice(-5);
        const lastAction = recentActions[recentActions.length - 1];
        if (lastAction && action.targetId === lastAction.targetId && action.type === lastAction.type) {
          // Same action repeated twice in a row - skip this element
          addLog(`⚠️ Skipping repeated action on element #${action.targetId}`);
          filledIds.add(action.targetId);
          recentActionHistory.push({ targetId: action.targetId, type: action.type });
          continue;
        }

        if (action.type === 'SCROLL') {
          consecutiveScrolls++;
          if (consecutiveScrolls > 3) {
            addLog('⚠️ Too many scrolls, stopping to prevent loop');
            break;
          }
          addLog(`Scrolling page... (${consecutiveScrolls}/3)`);
          const scrollResult: any = await browser.runtime.sendMessage({
            type: 'EXECUTE',
            // doScroll (src/lib/actions.ts) reads `scrollDirection`/`scrollAmount`.
            // We previously sent `direction`/`amount`, which it ignored and fell
            // back to a hard-coded 400px — now forward the planner's intent.
            action: {
              type: 'SCROLL',
              scrollDirection: action.scrollDirection || 'down',
              scrollAmount: action.scrollAmount || 500,
            }
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
            recentActionHistory.push({ targetId: action.targetId, type: 'TYPE' });
          } else {
            addLog(`❌ Type failed: ${result?.error ?? 'unknown'}`);
            // Issue #63: record as FAILED (retryable) with the error reason so
            // the planner can re-plan — NOT as filled/OK (the old behaviour).
            failedIds.add(action.targetId);
            failedErrors.set(action.targetId, result?.error ?? 'unknown');
            recentActionHistory.push({ targetId: action.targetId, type: 'TYPE' });
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

            // Autonomy: the planner (not a hardcoded guess) owns DONE. A submit
            // click may end the task OR continue it (confirmation page, next
            // step, another section) - re-plan against the new page state
            // instead of force-stopping the agent at the first submit. Loop
            // detection + maxSteps + the planner's own DONE judgment are the
            // real safeguards.
            if (action.targetId === buttons[buttons.length - 1]?.id) {
              addLog('🎯 Submit button clicked - re-planning against the result page');
            }
          } else {
            addLog(`❌ Click failed: ${result?.error ?? 'unknown'}`);
            // Issue #63: a failed click is retryable, not "done" — record it as
            // FAILED with the reason so the planner can re-plan.
            failedIds.add(action.targetId);
            failedErrors.set(action.targetId, result?.error ?? 'unknown');
          }
        } else if (action.type === 'SELECT' && action.targetId && action.value) {
          consecutiveScrolls = 0;
          // Dropdowns: route through the content relay, which runs the SELECT
          // executor in src/lib/actions.ts (matches an option by value or text
          // and fires a change event). Previously this fell into "Unknown
          // action", so the agent could not operate on any <select>.
          addLog(`Selecting "${action.value}" in element #${action.targetId}`);
          const result: any = await browser.runtime.sendMessage({
            type: 'EXECUTE',
            action,
          });
          if (result?.ok) {
            addLog('✅ Selected successfully');
            setStep(currentStep);
            filledIds.add(action.targetId);
            recentActionHistory.push({ targetId: action.targetId, type: 'SELECT' });
          } else {
            addLog(`❌ Select failed: ${result?.error ?? 'unknown'}`);
            failedIds.add(action.targetId);
            failedErrors.set(action.targetId, result?.error ?? 'unknown');
            recentActionHistory.push({ targetId: action.targetId, type: 'SELECT' });
          }
        } else if (action.type === 'KEY') {
          // Issue #84: press a key so the agent can SUBMIT a filled field
          // (Enter) or navigate an autocomplete (ArrowDown/Tab/Escape). Routed
          // through the content relay like TYPE/CLICK/SELECT - doKey in
          // src/lib/actions.ts dispatches the full keydown/keypress/keyup triple.
          const key = action.key || 'Enter';
          consecutiveScrolls = 0;
          addLog(`⌨️ Pressing key "${key}"${action.targetId ? ` on element #${action.targetId}` : ''}`);
          const result: any = await browser.runtime.sendMessage({
            type: 'EXECUTE',
            action,
          });
          if (result?.ok) {
            addLog('✅ Key pressed successfully');
            setStep(currentStep);
            // Pressing Enter usually navigates (submit / autocomplete jump).
            // A page navigation drops the content port, which the background
            // EXECUTE handler now reports as ok:true with a "page navigated"
            // note - treat that as a fresh page and reset per-page state.
            const navigated = !!result.note && /navigat/i.test(result.note);
            if (navigated) {
              addLog('🧭 Key triggered a navigation - re-planning on the new page');
              consecutiveScrolls = 0;
              recentActionHistory = [];
              await new Promise((r) => setTimeout(r, 600));
            }
            recentActionHistory.push({ targetId: action.targetId ?? 'focus', type: 'KEY' });
          } else {
            addLog(`❌ Key press failed: ${result?.error ?? 'unknown'}`);
            recentActionHistory.push({ targetId: action.targetId ?? 'focus', type: 'KEY' });
          }
        } else if (action.type === 'WAIT') {
          // Let the page settle (loading / spinner / content appearing) before
          // re-planning. No target needed. Route through the content relay,
          // which now has a WAIT executor in src/lib/actions.ts.
          const waitMs = Number.isFinite(action.waitMs) ? action.waitMs : 1000;
          addLog(`⏳ Waiting ${waitMs}ms for page to settle...`);
          const result: any = await browser.runtime.sendMessage({
            type: 'EXECUTE',
            action: { type: 'WAIT', waitMs },
          });
          if (!result?.ok) {
            addLog(`⚠️ Wait reported issue: ${result?.error ?? 'unknown'}`);
          }
        } else if (action.type === 'NAVIGATE' && action.url) {
          // Multi-page autonomy: move to a different page. This must go through
          // the background NAVIGATE_TAB handler (browser.tabs.update + wait-for-
          // load), NOT the content relay - an in-page location.assign() would
          // unload the page and kill the content script before it could respond.
          addLog(`🧭 Navigating to ${action.url}`);
          const result: any = await browser.runtime.sendMessage({
            type: 'NAVIGATE_TAB',
            url: action.url,
          });
          if (result?.ok) {
            addLog('✅ Navigated (new page loaded)');
            setStep(currentStep);
            // The element IDs / scroll position are all stale on the new page.
            // Reset per-page loop-detection state; keep filledIds as a global
            // "what I've done" record (new-page IDs won't collide).
            consecutiveScrolls = 0;
            recentActionHistory = [];
            // Give the new page a moment for any client-side hydration before the
            // next EXTRACT re-plans against it.
            await new Promise((r) => setTimeout(r, 600));
          } else {
            addLog(`❌ Navigate failed: ${result?.error ?? 'unknown'}`);
            break;
          }
        } else {
          addLog(`Unknown action: ${JSON.stringify(action)}`);
          break;
        }

        // Issue #70: a Stop pressed during the inter-step delay should not be
        // forced to wait the full 800ms - poll it in small slices.
        for (let wait = 0; wait < 800; wait += 100) {
          await new Promise(r => setTimeout(r, 100));
          if (stopRequested.current) break;
        }
        if (stopRequested.current) {
          addLog('⏹ Stopped by user');
          break;
        }
      }

      if (stopRequested.current) {
        // Already logged "Stopped by user" above; nothing else to add.
      } else if (currentStep >= maxSteps) {
        addLog(`⚠️ Reached maximum steps (${maxSteps})`);
      }

      if (plannerDegraded && !stopRequested.current) {
        addLog('⚠️ Task ended while planner was DEGRADED - verify results manually (no LLM was driving this run)');
      } else if (!stopRequested.current) {
        addLog('Task completed');
      }
    } catch (err) {
      // Issue #70: an AbortError means the user pressed Stop while a /plan
      // request was in flight - that is a clean stop, not a task error.
      const aborted =
        err instanceof DOMException && err.name === 'AbortError' ||
        (err as { name?: string })?.name === 'AbortError';
      if (aborted) {
        addLog('⏹ Stopped by user (in-flight request cancelled)');
      } else {
        addLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setLatency(Math.round(performance.now() - started));
      setIsRunning(false);
      stopRequested.current = false;
    }
  };

  // Issue #70: request a stop. The running loop notices it at the top of the
  // next iteration (and the in-flight fetch is aborted via the signal). The
  // button only shows while a task is running.
  const handleStop = useCallback(() => {
    stopRequested.current = true;
  }, []);

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
        {/* Resource Monitor - at top for visibility */}
        <ResourceMonitor />
        
        {/* Provider Selection */}
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
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
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
                  browser.storage.local.set({ providerKey: selectedProvider, apiKey: providerKey });
                  setShowSettings(false);
                }}
              >Save</button>
            </div>
          )}
        </div>

        {/* Task Input */}
        <div className="task-input-section">
          <label className="input-label">Task Description</label>
          <textarea
            className="task-textarea"
            placeholder="e.g., Go to the signup page, fill the form, and submit. Or: navigate to example.com/pricing and click the Pro plan..."
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
          />
          <label className="input-label">Start URL (optional)</label>
          <input
            className="api-key-input"
            placeholder="e.g. https://example.com/signup — leave blank to use the current tab"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
          />
        </div>

        {/* Controls */}
        <div className="controls">
          {isRunning ? (
            <button
              className={`start-button running stop-button`}
              onClick={handleStop}
              title="Stop the running task"
            >
              ⏹ Stop Agent
            </button>
          ) : (
            <button
              className={`start-button`}
              onClick={handleStart}
              disabled={!task}
            >
              Start Agent
            </button>
          )}
          {step > 0 && (
            <div className="step-indicator">Step {step} of task execution</div>
          )}
          {latency !== null && (
            <div className="latency-display">Latency: {latency}ms</div>
          )}
        </div>

        {/* Activity Log - Collapsible */}
        <div className={`log-section ${logsCollapsed ? 'collapsed' : ''}`}>
          <div className="log-header" onClick={() => setLogsCollapsed(!logsCollapsed)}>
            <span className="log-title">Activity Log</span>
            <svg className="log-toggle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points={logsCollapsed ? "9 18 15 12 9 6" : "15 18 9 12 15 6"} />
            </svg>
          </div>
          {!logsCollapsed && (
            <div className="log-container">
              {logs.map((log, i) => (
                <div key={i} className="log-entry">{log}</div>
              ))}
            </div>
          )}
        </div>

        <div className="ledger-container">
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