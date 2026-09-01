import React, { useEffect, useRef } from 'react';
import type { BoundingBox } from '../types';

interface SoMOverlayProps {
  boxes: BoundingBox[];
  isVisible: boolean;
  onSelectBox?: (box: BoundingBox) => void;
  selectedId?: number | null;
}

const SoMOverlay: React.FC<SoMOverlayProps> = ({ boxes, isVisible, onSelectBox, selectedId }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !isVisible) return;

    const container = containerRef.current;
    container.innerHTML = '';

    boxes.forEach((box) => {
      const el = document.createElement('div');
      el.className = 'som-box';
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
      el.style.borderColor = selectedId === box.id ? '#818cf8' : '#6366f1';

      const label = document.createElement('span');
      label.className = 'som-label';
      label.textContent = `${box.id}. ${box.label || box.id}`;
      el.appendChild(label);

      el.addEventListener('click', () => onSelectBox?.(box));
      container.appendChild(el);
    });

    return () => {
      container.innerHTML = '';
    };
  }, [boxes, isVisible, selectedId, onSelectBox]);

  if (!isVisible || boxes.length === 0) return null;

  return <div ref={containerRef} className="extension-overlay" />;
};

export default SoMOverlay;
