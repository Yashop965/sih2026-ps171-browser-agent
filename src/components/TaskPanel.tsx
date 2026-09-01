import React from 'react';
import { useExtensionState } from '../hooks/useExtensionState';

const TaskPanel: React.FC = () => {
  const { state, startTask, stopTask } = useExtensionState();

  const handleStart = () => {
    const task = prompt('Enter your task:');
    if (task) {
      startTask(task);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      left: '20px',
      background: 'rgba(15, 23, 42, 0.95)',
      border: '1px solid #334155',
      borderRadius: '8px',
      padding: '16px',
      minWidth: '300px',
      zIndex: 2147483644,
    }}>
      <h3 style={{ marginBottom: '12px', color: '#f8fafc' }}>🎯 Active Task</h3>
      {state.task && (
        <div style={{ marginBottom: '8px', color: '#94a3b8', fontSize: '13px' }}>
          "{state.task}"
        </div>
      )}
      <div style={{ marginBottom: '8px', color: '#64748b', fontSize: '12px' }}>
        Step {state.step}/{state.maxSteps} • Status: {state.status}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={handleStart}
          disabled={state.status === 'running'}
          style={{
            flex: 1,
            padding: '8px',
            background: state.status === 'running' ? '#334155' : '#6366f1',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: state.status === 'running' ? 'not-allowed' : 'pointer',
            fontSize: '12px',
            fontWeight: 600,
          }}
        >
          {state.status === 'running' ? 'Running...' : 'New Task'}
        </button>
        {state.status === 'running' && (
          <button
            onClick={stopTask}
            style={{
              padding: '8px 12px',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
};

export default TaskPanel;
