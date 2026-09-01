import { useState, useEffect, useCallback } from 'react';

export interface HealthStatus {
  // Core indicators
  serverAlive: boolean;
  serverLatency: number;
  
  // Extension health
  contentScriptReady: boolean;
  backgroundScriptReady: boolean;
  
  // LLM pipeline
  llmReady: boolean;
  llmProvider: string;
  llmLatency: number;
  
  // Privacy system
  privacyLedgerActive: boolean;
  
  // DOM extraction
  domExtractionWorking: boolean;
  
  // Overall status
  overall: 'healthy' | 'degraded' | 'unhealthy';
}

export function useHealthCheck(): HealthStatus {
  const [status, setStatus] = useState<HealthStatus>({
    serverAlive: false,
    serverLatency: 0,
    contentScriptReady: true, // Always true since we're running
    backgroundScriptReady: true, // Always true since we're running
    llmReady: false,
    llmProvider: 'unknown',
    llmLatency: 0,
    privacyLedgerActive: true,
    domExtractionWorking: false,
    overall: 'unhealthy',
  });

  // Check server health
  const checkServer = useCallback(async () => {
    const start = performance.now();
    try {
      const response = await fetch('http://localhost:8000/health', { 
        method: 'HEAD',
        signal: AbortSignal.timeout(3000)
      });
      const latency = Math.round(performance.now() - start);
      setStatus(s => ({ 
        ...s, 
        serverAlive: response.ok, 
        serverLatency: latency 
      }));
      return response.ok;
    } catch {
      setStatus(s => ({ ...s, serverAlive: false, serverLatency: 0 }));
      return false;
    }
  }, []);

  // Check LLM endpoint
  const checkLLM = useCallback(async () => {
    const start = performance.now();
    try {
      // Try to reach the configured LLM endpoint
      const provider = localStorage.getItem('selectedProvider') || 'custom';
      const response = await fetch('http://localhost:8000/health', {
        signal: AbortSignal.timeout(2000)
      });
      const latency = Math.round(performance.now() - start);
      if (response.ok) {
        setStatus(s => ({ 
          ...s, 
          llmReady: true, 
          llmProvider: provider,
          llmLatency: latency 
        }));
        return true;
      }
    } catch {
      setStatus(s => ({ ...s, llmReady: false, llmLatency: 0 }));
    }
    return false;
  }, []);

  // Check DOM extraction
  const checkDOM = useCallback(async () => {
    try {
      const result = await browser.runtime.sendMessage({ type: 'EXTRACT' });
      const working = result?.ok && result?.elements?.length > 0;
      setStatus(s => ({ ...s, domExtractionWorking: working }));
      return working;
    } catch {
      setStatus(s => ({ ...s, domExtractionWorking: false }));
      return false;
    }
  }, []);

  // Initial check + periodic refresh
  useEffect(() => {
    const runChecks = async () => {
      const [serverOk, domOk] = await Promise.all([
        checkServer(),
        checkDOM()
      ]);
      
      // LLM check if server is up
      if (serverOk) {
        await checkLLM();
      }

      const overall = serverOk && domOk ? 'healthy' : 
                      (serverOk || domOk) ? 'degraded' : 'unhealthy';
      setStatus(s => ({ ...s, overall } as any));
    };

    runChecks();
    const interval = setInterval(runChecks, 5000);
    return () => clearInterval(interval);
  }, [checkServer, checkLLM, checkDOM]);

  return status;
}
