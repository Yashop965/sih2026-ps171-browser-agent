import React, { useState } from 'react';

function Options() {
  const [plannerUrl, setPlannerUrl] = useState('http://localhost:8000');
  const [modelId, setModelId] = useState('onnx-community/Florence-2-base-ft');
  const [backend, setBackend] = useState('webgpu');

  const handleSave = async () => {
    await chrome.storage.sync.set({ plannerUrl, modelId, backend });
    alert('Settings saved!');
  };

  return (
    <div style={{ padding: '20px', maxWidth: '500px' }}>
      <h1>SIH2026 PS171 Browser Agent Settings</h1>
      
      <div style={{ marginTop: '20px' }}>
        <label>Planner Server URL:</label>
        <input
          type="text"
          value={plannerUrl}
          onChange={(e) => setPlannerUrl(e.target.value)}
          style={{ width: '100%', padding: '8px', marginTop: '4px' }}
        />
      </div>

      <div style={{ marginTop: '20px' }}>
        <label>Vision Model ID:</label>
        <input
          type="text"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          style={{ width: '100%', padding: '8px', marginTop: '4px' }}
        />
      </div>

      <div style={{ marginTop: '20px' }}>
        <label>Inference Backend:</label>
        <select
          value={backend}
          onChange={(e) => setBackend(e.target.value)}
          style={{ width: '100%', padding: '8px', marginTop: '4px' }}
        >
          <option value="webgpu">WebGPU (Fastest, Chrome only)</option>
          <option value="wasm">WASM (Fallback, Firefox compatible)</option>
        </select>
      </div>

      <button
        onClick={handleSave}
        style={{
          marginTop: '30px',
          padding: '10px 20px',
          background: '#6366f1',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          cursor: 'pointer',
          fontWeight: '600'
        }}
      >
        Save Settings
      </button>
    </div>
  );
}

export default Options;
