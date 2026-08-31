import { useState, useCallback, useRef } from 'react';
import { detectPII, redactPII } from '../lib/privacy';
import type { PrivacyEvent } from '../types';

export function usePIIDetector() {
  const [events, setEvents] = useState<PrivacyEvent[]>([]);
  const eventsRef = useRef<PrivacyEvent[]>([]);

  const addEvent = useCallback((event: Omit<PrivacyEvent, 'id' | 'timestamp'>) => {
    const newEvent: PrivacyEvent = {
      ...event,
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date(),
    };
    eventsRef.current = [newEvent, ...eventsRef.current];
    setEvents([...eventsRef.current]);
  }, []);

  const scanText = useCallback((text: string): PrivacyEvent[] => {
    const detections = detectPII(text);
    const newEvents: PrivacyEvent[] = [];

    for (const det of detections) {
      newEvents.push({
        type: 'detected',
        category: det.type,
        detail: `${det.type} detected`,
        confidence: det.confidence,
      });
    }

    if (newEvents.length > 0) {
      newEvents.forEach(e => addEvent(e));
    }

    return newEvents;
  }, [addEvent]);

  const redactText = useCallback((text: string): { redacted: string; events: PrivacyEvent[] } => {
    const { redacted, events: detections } = redactPII(text);
    const newEvents: PrivacyEvent[] = detections.map(det => ({
      type: 'redacted',
      category: det.type,
      detail: `Redacted ${det.type}`,
      confidence: det.confidence,
    }));

    newEvents.forEach(e => addEvent(e));

    return { redacted, events: newEvents };
  }, [addEvent]);

  const clearEvents = useCallback(() => {
    eventsRef.current = [];
    setEvents([]);
  }, []);

  return {
    events,
    scanText,
    redactText,
    clearEvents,
  };
}
