import { useState, useCallback, useRef } from 'react';
import type { TaskState, ActionCommand } from '../types';

const MAX_STEPS = 20;

export function useExtensionState() {
  const [state, setState] = useState<TaskState>({
    status: 'idle',
    step: 0,
    maxSteps: MAX_STEPS,
    task: '',
    history: [],
  });
  const abortRef = useRef(false);

  const startTask = useCallback((task: string) => {
    setState({
      status: 'running',
      step: 0,
      maxSteps: MAX_STEPS,
      task,
      history: [],
    });
    abortRef.current = false;
  }, []);

  const pauseTask = useCallback(() => {
    setState((prev: TaskState) => ({ ...prev, status: 'paused' }));
  }, []);

  const resumeTask = useCallback(() => {
    setState((prev: TaskState) => ({ ...prev, status: 'running' }));
  }, []);

  const stopTask = useCallback(() => {
    abortRef.current = true;
    setState((prev: TaskState) => ({ ...prev, status: 'idle', step: 0 }));
  }, []);

  const advanceStep = useCallback((action: ActionCommand) => {
    setState((prev: TaskState) => ({
      ...prev,
      step: prev.step + 1,
      history: [...prev.history, action],
    }));
  }, []);

  const completeTask = useCallback(() => {
    setState((prev: TaskState) => ({ ...prev, status: 'complete' }));
  }, []);

  const setError = useCallback((error: string) => {
    setState((prev: TaskState) => ({ ...prev, status: 'error', error }));
  }, []);

  return {
    state,
    abortRef,
    startTask,
    pauseTask,
    resumeTask,
    stopTask,
    advanceStep,
    completeTask,
    setError,
  };
}
