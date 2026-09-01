export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TransformedPoint {
  x: number;
  y: number;
}

/**
 * Converts a screen-space coordinate into
 * coordinates relative to an element.
 */
export function screenToElement(
  point: ScreenPoint,
  element: ElementRect
): TransformedPoint {
  return {
    x: point.x - element.x,
    y: point.y - element.y,
  };
}

/**
 * Converts element-space coordinates back
 * into screen-space coordinates.
 */
export function elementToScreen(
  point: TransformedPoint,
  element: ElementRect
): ScreenPoint {
  return {
    x: point.x + element.x,
    y: point.y + element.y,
  };
}

/**
 * Converts a bounding box from screen coordinates
 * into coordinates relative to a container.
 */
export function screenRectToElement(
  rect: ElementRect,
  container: ElementRect
): ElementRect {
  return {
    x: rect.x - container.x,
    y: rect.y - container.y,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Converts normalized coordinates (0-1)
 * into pixel coordinates.
 */
export function normalizedToPixels(
  x: number,
  y: number,
  width: number,
  height: number
): ScreenPoint {
  return {
    x: x * width,
    y: y * height,
  };
}

/**
 * Converts pixel coordinates into normalized
 * coordinates (0-1).
 */
export function pixelsToNormalized(
  x: number,
  y: number,
  width: number,
  height: number
): ScreenPoint {
  return {
    x: width === 0 ? 0 : x / width,
    y: height === 0 ? 0 : y / height,
  };
}

/**
 * Checks whether a point lies inside a bounding box.
 */
export function isPointInsideRect(
  point: ScreenPoint,
  rect: ElementRect
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Clamp a coordinate to the boundaries of a rectangle.
 */
export function clampPointToRect(
  point: ScreenPoint,
  rect: ElementRect
): ScreenPoint {
  return {
    x: Math.max(
      rect.x,
      Math.min(point.x, rect.x + rect.width)
    ),

    y: Math.max(
      rect.y,
      Math.min(point.y, rect.y + rect.height)
    ),
  };
}