import React, { useEffect, useRef, useState } from "react";

const DEFAULT_DETECTIONS = [
  {
    id: 1,
    x: 120,
    y: 100,
    width: 180,
    height: 55,
    label: "Login",
    layer: "DOM",
  },
  {
    id: 2,
    x: 350,
    y: 180,
    width: 220,
    height: 65,
    label: "Search",
    layer: "Vision",
  },
  {
    id: 3,
    x: 620,
    y: 100,
    width: 150,
    height: 55,
    label: "Submit",
    layer: "DOM",
  },
  {
    id: 4,
    x: 220,
    y: 330,
    width: 200,
    height: 70,
    label: "Menu",
    layer: "Vision",
  },
];

function SoMOverlay({
  detections = DEFAULT_DETECTIONS,
  visible = true,
  onSelect,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);

  /*
   * Draw all numbered bounding boxes.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;

    if (!canvas || !container || !visible) {
      return;
    }

    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;

    const devicePixelRatio = window.devicePixelRatio || 1;

    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(
      devicePixelRatio,
      0,
      0,
      devicePixelRatio,
      0,
      0
    );

    ctx.clearRect(0, 0, width, height);

    detections.forEach((item) => {
      const isSelected = item.id === selectedId;
      const isHovered = item.id === hoveredId;

      let borderColor = "#38bdf8";

      if (item.layer === "Vision") {
        borderColor = "#a78bfa";
      }

      if (isHovered) {
        borderColor = "#facc15";
      }

      if (isSelected) {
        borderColor = "#22c55e";
      }

      const scale = isHovered || isSelected ? 1.03 : 1;

      const centerX = item.x + item.width / 2;
      const centerY = item.y + item.height / 2;

      const scaledWidth = item.width * scale;
      const scaledHeight = item.height * scale;

      const drawX = centerX - scaledWidth / 2;
      const drawY = centerY - scaledHeight / 2;

      /*
       * Bounding box
       */
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = isSelected ? 3 : 2;

      ctx.strokeRect(
        drawX,
        drawY,
        scaledWidth,
        scaledHeight
      );

      /*
       * Transparent fill
       */
      ctx.fillStyle = isSelected
        ? "rgba(34, 197, 94, 0.14)"
        : isHovered
        ? "rgba(250, 204, 21, 0.12)"
        : "rgba(56, 189, 248, 0.08)";

      ctx.fillRect(
        drawX,
        drawY,
        scaledWidth,
        scaledHeight
      );

      /*
       * Number badge
       */
      const badgeSize = 26;

      ctx.fillStyle = borderColor;

      ctx.beginPath();

      ctx.roundRect(
        drawX - 2,
        drawY - badgeSize - 4,
        badgeSize,
        badgeSize,
        6
      );

      ctx.fill();

      /*
       * Number text
       */
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 13px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.fillText(
        String(item.id),
        drawX - 2 + badgeSize / 2,
        drawY - badgeSize / 2 - 4
      );

      /*
       * Label
       */
      if (isHovered || isSelected) {
        ctx.font = "600 12px Arial";
        ctx.textAlign = "left";

        ctx.fillStyle = "#ffffff";

        ctx.fillText(
          `${item.label} • ${item.layer}`,
          drawX,
          drawY + scaledHeight + 18
        );
      }
    });
  }, [
    detections,
    visible,
    selectedId,
    hoveredId,
  ]);

  /*
   * Convert screen coordinates into
   * coordinates relative to the canvas.
   */
  const getCanvasCoordinates = (event) => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  /*
   * Find which detection was clicked/hovered.
   */
  const findDetection = (x, y) => {
    for (let i = detections.length - 1; i >= 0; i--) {
      const item = detections[i];

      if (
        x >= item.x &&
        x <= item.x + item.width &&
        y >= item.y &&
        y <= item.y + item.height
      ) {
        return item;
      }
    }

    return null;
  };

  /*
   * Click-to-select.
   */
  const handleClick = (event) => {
    const coordinates = getCanvasCoordinates(event);

    if (!coordinates) {
      return;
    }

    const item = findDetection(
      coordinates.x,
      coordinates.y
    );

    if (!item) {
      setSelectedId(null);
      return;
    }

    setSelectedId(item.id);

    if (onSelect) {
      onSelect(item);
    }
  };

  /*
   * Hover interaction.
   */
  const handleMouseMove = (event) => {
    const coordinates = getCanvasCoordinates(event);

    if (!coordinates) {
      return;
    }

    const item = findDetection(
      coordinates.x,
      coordinates.y
    );

    setHoveredId(item ? item.id : null);

    const canvas = canvasRef.current;

    if (canvas) {
      canvas.style.cursor = item
        ? "pointer"
        : "default";
    }
  };

  const handleMouseLeave = () => {
    setHoveredId(null);
  };

  return (
    <div
      ref={containerRef}
      className={`som-overlay ${
        visible ? "som-visible" : "som-hidden"
      }`}
    >
      {visible && (
        <canvas
          ref={canvasRef}
          className="som-canvas"
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      )}
    </div>
  );
}

export default SoMOverlay;