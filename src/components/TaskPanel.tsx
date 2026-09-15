import React, { useState } from 'react';
import { useExtensionState } from '../hooks/useExtensionState';

const TaskPanel: React.FC = () => {
  const { state, startTask, stopTask } = useExtensionState();
  const [taskInput, setTaskInput] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (taskInput.trim()) {
      startTask(taskInput.trim());
      setTaskInput('');
      setIsInputFocused(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
    if (e.key === 'Escape') {
      setTaskInput('');
      setIsInputFocused(false);
    }
  };

  const getStatusColor = () => {
    switch (state.status) {
      case 'running': return '#2D5A27';
      case 'paused': return '#8B6914';
      case 'error': return '#8B2E2E';
      case 'complete': return '#2D5A27';
      default: return '#6B6B6B';
    }
  };

  const getProgressWidth = () => {
    if (state.maxSteps === 0) return '0%';
    return `${Math.min(100, (state.step / state.maxSteps) * 100)}%`;
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '20px',
        left: '20px',
        background: '#FFFFFF',
        border: '1px solid #E2E0DB',
        borderRadius: '12px',
        padding: '16px',
        minWidth: '320px',
        maxWidth: '400px',
        zIndex: 2147483644,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#0A0A0A', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          🎯 Task Progress
        </h3>
        <span
          style={{
            fontSize: '10px',
            color: getStatusColor(),
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: getStatusColor(),
            display: 'inline-block',
            animation: state.status === 'running' ? 'pulse 1.5s infinite' : 'none',
          }} />
          {state.status}
        </span>
      </div>

      {/* Task Display or Input */}
      {!state.task ? (
        /* Input Form */
        <form onSubmit={handleSubmit} style={{ marginBottom: '12px' }}>
          <div style={{
            position: 'relative',
            border: `2px solid ${isInputFocused ? '#0A0A0A' : '#E2E0DB'}`,
            borderRadius: '8px',
            transition: 'border-color 0.2s ease',
          }}>
            <input
              type="text"
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your task..."
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: '13px',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: '#0A0A0A',
                fontFamily: 'inherit',
              }}
            />
            <div style={{
              padding: '0 12px 8px',
              fontSize: '11px',
              color: '#9A9A9A',
            }}>
              Press Enter to start • Esc to clear
            </div>
          </div>
          <button
            type="submit"
            disabled={!taskInput.trim() || state.status === 'running'}
            style={{
              width: '100%',
              marginTop: '8px',
              padding: '10px',
              background: taskInput.trim() && state.status !== 'running' ? '#0A0A0A' : '#EDEBE7',
              color: taskInput.trim() && state.status !== 'running' ? '#FFFFFF' : '#9A9A9A',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: taskInput.trim() && state.status !== 'running' ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s ease',
            }}
          >
            {state.status === 'running' ? 'Running...' : 'Start Task'}
          </button>
        </form>
      ) : (
        /* Active Task Display */
        <div style={{ marginBottom: '12px' }}>
          <div style={{
            fontSize: '13px',
            color: '#0A0A0A',
            fontWeight: 500,
            marginBottom: '8px',
            padding: '8px 10px',
            background: '#F5F4F1',
            borderRadius: '6px',
            borderLeft: '3px solid #0A0A0A',
          }}>
            "{state.task}"
          </div>

          {/* Progress Bar */}
          <div style={{ marginBottom: '8px' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '11px',
              color: '#6B6B6B',
              marginBottom: '4px',
            }}>
              <span>Step {state.step}/{state.maxSteps}</span>
              <span>{getProgressWidth()}</span>
            </div>
            <div style={{
              height: '4px',
              background: '#EDEBE7',
              borderRadius: '2px',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: getProgressWidth(),
                background: state.status === 'running' ? '#2D5A27' : '#6B6B6B',
                transition: 'width 0.3s ease',
                borderRadius: '2px',
              }} />
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: '8px' }}>
            {state.status === 'running' && (
              <button
                onClick={stopTask}
                style={{
                  flex: 1,
                  padding: '8px',
                  background: '#8B2E2E',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background 0.2s ease',
                }}
              >
                Stop Task
              </button>
            )}
            <button
              onClick={() => {
                stopTask();
                setTaskInput('');
                setIsInputFocused(true);
              }}
              style={{
                flex: 1,
                padding: '8px',
                background: state.status === 'running' ? '#EDEBE7' : '#F5F4F1',
                color: state.status === 'running' ? '#6B6B6B' : '#0A0A0A',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: state.status === 'running' ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s ease',
              }}
              disabled={state.status === 'running'}
            >
              New Task
            </button>
          </div>
        </div>
      )}

      {/* CSS Animation for pulse */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
};

export default TaskPanel;
