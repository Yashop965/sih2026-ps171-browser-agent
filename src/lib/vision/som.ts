/**
 * Set-of-Marks (SoM) Renderer
 *
 * Renders numbered bounding boxes on detected UI elements
 * for vision model grounding and human review
 */

export interface MarkOptions {
  fontSize?: number;
  boxColor?: string;
  backgroundColor?: string;
  showLabels?: boolean;
}

export interface Mark {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  type: string;
}

export class SomRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private marks: Mark[] = [];
  private options: MarkOptions;

  constructor(options: MarkOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 2147483646;
      pointer-events: none;
      opacity: 0.9;
    `;
    document.body.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d')!;
    this.options = {
      fontSize: 14,
      boxColor: '#00FF00',
      backgroundColor: 'rgba(0, 255, 0, 0.1)',
      showLabels: true,
      ...options,
    };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.render();
  }

  setMarks(marks: Mark[]): void {
    this.marks = marks;
    this.render();
  }

  addMark(mark: Mark): void {
    this.marks.push(mark);
    this.render();
  }

  clearMarks(): void {
    this.marks = [];
    this.render();
  }

  private render(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.font = `${this.options.fontSize}px Arial`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    for (const mark of this.marks) {
      this.drawMark(mark);
    }
  }

  private drawMark(mark: Mark): void {
    const { x, y, width, height, id, label } = mark;

    // Draw box
    this.ctx.strokeStyle = this.options.boxColor;
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(x, y, width, height);

    // Fill background
    this.ctx.fillStyle = this.options.backgroundColor;
    this.ctx.fillRect(x, y, width, height);

    // Draw label
    if (this.options.showLabels) {
      // Label background
      const textWidth = this.ctx.measureText(`${id}`).width;
      this.ctx.fillStyle = this.options.boxColor;
      this.ctx.fillRect(x, y - 20, textWidth + 8, 20);

      // Label text
      this.ctx.fillStyle = '#000';
      this.ctx.fillText(`${id}`, x + textWidth / 2 + 4, y - 10);

      // Element label below
      if (label) {
        this.ctx.fillStyle = '#FFF';
        this.ctx.fillText(label, x + width / 2, y + height + 16);
      }
    }
  }

  destroy(): void {
    this.canvas.remove();
  }
}

export const somRenderer = new SomRenderer();
