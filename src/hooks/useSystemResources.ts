import { useState, useEffect, useCallback } from 'react';

export interface SystemResources {
  // Memory
  jsHeapUsedMB: number;
  jsHeapTotalMB: number;
  jsHeapPercent: number;
  
  // CPU
  cpuCores: number;
  
  // GPU
  gpuAdapter: string | null;
  gpuVendor: string | null;
  
  // Overall health
  status: 'healthy' | 'warning' | 'critical';
  lastUpdated: number;
}

export function useSystemResources(): SystemResources {
  const [resources, setResources] = useState<SystemResources>({
    jsHeapUsedMB: 0,
    jsHeapTotalMB: 0,
    jsHeapPercent: 0,
    cpuCores: navigator.hardwareConcurrency || 4,
    gpuAdapter: null,
    gpuVendor: null,
    status: 'healthy',
    lastUpdated: Date.now(),
  });

  const checkGPU = useCallback(async (): Promise<{ adapter: string | null, vendor: string | null }> => {
    try {
      if (!navigator.gpu) {
        // Fallback to WebGL
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (gl) {
          const renderer = gl.getExtension('WEBGL_debug_renderer_info');
          if (renderer) {
            return {
              adapter: gl.getParameter(renderer.UNMASKED_RENDERER_WEBGL),
              vendor: gl.getParameter(renderer.UNMASKED_VENDOR_WEBGL),
            };
          }
        }
        return { adapter: 'WebGL', vendor: null };
      }
      
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = await adapter.requestAdapterInfo();
        return {
          adapter: info.device || info.description || 'GPU',
          vendor: info.vendor || null,
        };
      }
      return { adapter: 'No GPU', vendor: null };
    } catch {
      return { adapter: null, vendor: null };
    }
  }, []);

  useEffect(() => {
    const updateResources = async () => {
      // Memory stats (Chrome-only API)
      const memory = (performance as any).memory;
      let jsHeapUsedMB = 0;
      let jsHeapTotalMB = 0;
      let jsHeapPercent = 0;
      
      if (memory) {
        jsHeapUsedMB = Math.round(memory.usedJSHeapSize / 1024 / 1024);
        jsHeapTotalMB = Math.round(memory.jsHeapSizeLimit / 1024 / 1024);
        jsHeapPercent = Math.round((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100);
      }
      
      // GPU info
      const { adapter, vendor } = await checkGPU();
      
      // Determine status based on memory usage
      let status: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (jsHeapPercent > 80) status = 'critical';
      else if (jsHeapPercent > 50) status = 'warning';
      
      setResources({
        jsHeapUsedMB,
        jsHeapTotalMB,
        jsHeapPercent,
        cpuCores: navigator.hardwareConcurrency || 4,
        gpuAdapter: adapter,
        gpuVendor: vendor,
        status,
        lastUpdated: Date.now(),
      });
    };

    // Initial check
    updateResources();
    
    // Poll every 2 seconds
    const interval = setInterval(updateResources, 2000);
    
    return () => clearInterval(interval);
  }, [checkGPU]);

  return resources;
}
