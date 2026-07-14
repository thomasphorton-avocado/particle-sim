import { Grid } from "./grid";
import { FLOWER_PALETTE, MATERIALS, MaterialId } from "./materials";
import type { ObjectPlacement } from "./materials";

interface CloudPuff {
  dx: number;
  dy: number;
  r: number;
}

interface Cloud {
  baseX: number;
  y: number;
  speed: number;
  opacity: number;
  puffs: CloudPuff[];
}

const CLOUD_COUNT = 7;

/**
 * Renders the grid at 1 pixel per cell into an offscreen buffer, then blits
 * that buffer scaled up to the visible canvas. Far cheaper than drawing
 * thousands of individual scaled rects per frame.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cellSize: number;
  private buffer: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D;
  private imageData: ImageData;
  private clouds: Cloud[];

  constructor(canvas: HTMLCanvasElement, grid: Grid, cellSize: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.cellSize = cellSize;

    canvas.width = grid.width * cellSize;
    canvas.height = grid.height * cellSize;
    this.ctx.imageSmoothingEnabled = false;

    this.buffer = document.createElement("canvas");
    this.buffer.width = grid.width;
    this.buffer.height = grid.height;
    const bufferCtx = this.buffer.getContext("2d");
    if (!bufferCtx) throw new Error("2D context unavailable");
    this.bufferCtx = bufferCtx;
    this.imageData = this.bufferCtx.createImageData(grid.width, grid.height);

    this.clouds = this.generateClouds(canvas.width, canvas.height);
  }

  private generateClouds(width: number, height: number): Cloud[] {
    const clouds: Cloud[] = [];
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const puffs: CloudPuff[] = [];
      const puffCount = 4 + Math.floor(Math.random() * 3);
      for (let p = 0; p < puffCount; p++) {
        puffs.push({
          dx: (Math.random() - 0.5) * 120,
          dy: (Math.random() - 0.5) * 20,
          r: 22 + Math.random() * 26,
        });
      }
      clouds.push({
        baseX: Math.random() * (width + 300) - 150,
        y: height * (0.06 + Math.random() * 0.32),
        speed: 3 + Math.random() * 5,
        opacity: 0.5 + Math.random() * 0.35,
        puffs,
      });
    }
    return clouds;
  }

  /** Paints a dusk sky gradient with soft drifting clouds — deliberately warm so it reads
   * distinctly from the blue water rather than blending into it. */
  private drawBackground(): void {
    const { width, height } = this.ctx.canvas;
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#241b4e");
    gradient.addColorStop(0.5, "#7a3f7d");
    gradient.addColorStop(1, "#f0824f");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);

    const t = performance.now() / 1000;
    const wrap = width + 300;
    this.ctx.save();
    for (const cloud of this.clouds) {
      const x = (((cloud.baseX + t * cloud.speed) % wrap) + wrap) % wrap - 150;
      this.ctx.fillStyle = `rgba(255, 248, 240, ${cloud.opacity})`;
      this.ctx.beginPath();
      for (const puff of cloud.puffs) {
        this.ctx.moveTo(x + puff.dx + puff.r, cloud.y + puff.dy);
        this.ctx.arc(x + puff.dx, cloud.y + puff.dy, puff.r, 0, Math.PI * 2);
      }
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  draw(grid: Grid): void {
    const data = this.imageData.data;
    for (let i = 0; i < grid.ids.length; i++) {
      const id = grid.ids[i] as MaterialId;
      const material = MATERIALS[id];
      const shade = grid.shade[i];
      const o = i * 4;
      // Flowers store their randomly-chosen bloom color's palette index in `vx`.
      const color = id === MaterialId.Flower ? FLOWER_PALETTE[grid.vx[i]] : material.color;
      data[o] = clamp(color[0] + shade);
      data[o + 1] = clamp(color[1] + shade);
      data[o + 2] = clamp(color[2] + shade);
      data[o + 3] = id === MaterialId.Empty ? 0 : 255;
    }
    this.bufferCtx.clearRect(0, 0, this.buffer.width, this.buffer.height);
    this.bufferCtx.putImageData(this.imageData, 0, 0);

    this.drawBackground();
    this.ctx.drawImage(
      this.buffer,
      0,
      0,
      this.buffer.width * this.cellSize,
      this.buffer.height * this.cellSize,
    );

    this.drawObjectOutlines(grid);
  }

  /** Traces a contrasting border around the edges of any placed-object regions (e.g. wood, stone). */
  private drawObjectOutlines(grid: Grid): void {
    const cs = this.cellSize;
    const ids = grid.ids;

    this.ctx.save();
    this.ctx.strokeStyle = "rgba(18, 14, 10, 0.85)";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    for (let y = 0; y < grid.height; y++) {
      const rowOffset = y * grid.width;
      for (let x = 0; x < grid.width; x++) {
        const id = ids[rowOffset + x] as MaterialId;
        if (MATERIALS[id].placement.kind !== "object") continue;

        const left = x * cs;
        const top = y * cs;
        const right = left + cs;
        const bottom = top + cs;

        if (grid.get(x, y - 1) !== id) {
          this.ctx.moveTo(left, top);
          this.ctx.lineTo(right, top);
        }
        if (grid.get(x, y + 1) !== id) {
          this.ctx.moveTo(left, bottom);
          this.ctx.lineTo(right, bottom);
        }
        if (grid.get(x - 1, y) !== id) {
          this.ctx.moveTo(left, top);
          this.ctx.lineTo(left, bottom);
        }
        if (grid.get(x + 1, y) !== id) {
          this.ctx.moveTo(right, top);
          this.ctx.lineTo(right, bottom);
        }
      }
    }
    this.ctx.stroke();
    this.ctx.restore();
  }

  /** Draws a translucent outline of an object's footprint centered on grid cell (gx, gy). */
  drawObjectPreview(
    gx: number,
    gy: number,
    placement: ObjectPlacement,
    color: [number, number, number],
  ): void {
    const { shape, width, height } = placement;
    const cs = this.cellSize;
    const left = (gx - width / 2) * cs;
    const top = (gy - height / 2) * cs;
    const w = width * cs;
    const h = height * cs;
    const [r, g, b] = color;

    this.ctx.save();
    this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.45)`;
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    if (shape === "circle") {
      this.ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      this.ctx.rect(left, top, w, h);
    }
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
