import { useState, useEffect, type ChangeEvent } from 'react';
import { browser } from 'wxt/browser';
import { loadProfile, saveProfile, type UserProfile, PROFILE_TOKENS } from '../lib/userProfile';

const PROFILE_KEYS = Object.keys(PROFILE_TOKENS) as Array<keyof typeof PROFILE_TOKENS>;

function Options() {
  const [plannerUrl, setPlannerUrl] = useState(import.meta.env.VITE_SERVER_URL || 'http://localhost:8000');
  const [modelId, setModelId] = useState('onnx-community/Florence-2-base-ft');
  const [backend, setBackend] = useState('webgpu');
  const [profile, setProfile] = useState<UserProfile>({});
  const [profileSaved, setProfileSaved] = useState(false);

  useEffect(() => {
    loadProfile().then(setProfile).catch(() => setProfile({}));
  }, []);

  const handleSave = async () => {
    await browser.storage.sync.set({ plannerUrl, modelId, backend });
    alert('Settings saved!');
  };

  const handleSaveProfile = async () => {
    // Local-only: browser.storage.local, never synced, never egressed.
    await saveProfile(profile);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  };

  const setField = (k: keyof typeof PROFILE_TOKENS) => (e: ChangeEvent<HTMLInputElement>) =>
    setProfile((p) => ({ ...p, [k]: e.target.value }));

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

      {/* ── #102: local user profile (on-device constants) ── */}
      <div style={{ marginTop: '30px', padding: '16px', border: '1px solid #e5e7eb', borderRadius: '8px', background: '#f9fafb' }}>
        <h2 style={{ fontSize: '16px', margin: '0 0 4px' }}>Local User Profile</h2>
        <p style={{ fontSize: '12px', color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5 }}>
          Personal constants the agent can fill when a task references them
          ("fill my email", "use my address"). Stored <strong>locally only</strong>
          on this device — never synced and never sent to the planner in the
          clear (the planner sees a token like <code>&lt;EMAIL&gt;</code>; the real
          value is filled in on-device at execution time).
        </p>
        {PROFILE_KEYS.map((k) => (
          <div key={k} style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '13px', fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ textTransform: 'capitalize', minWidth: '80px' }}>{k}</span>
              <code style={{ fontSize: '11px', color: '#9ca3af', fontWeight: 400 }}>{PROFILE_TOKENS[k]}</code>
            </label>
            <input
              type="text"
              value={profile[k] ?? ''}
              onChange={setField(k)}
              placeholder={k === 'email' ? 'you@example.com' : k === 'phone' ? '+91 …' : ''}
              style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
            />
          </div>
        ))}
        <button
          onClick={handleSaveProfile}
          style={{
            marginTop: '6px', padding: '8px 16px',
            background: profileSaved ? '#059669' : '#111827', color: '#fff',
            border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px',
          }}
        >
          {profileSaved ? '✓ Saved locally' : 'Save Profile (local only)'}
        </button>
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
