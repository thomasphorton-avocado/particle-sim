import { Grid } from "./grid";
import { FLOWER_PALETTE, MATERIALS, MaterialId } from "./materials";
import type { ObjectPlacement } from "./materials";

interface CloudPuff {
  dx: number; // base offset in grid cells
  dy: number;
  r: number;  // base radius in grid cells
  // Animation parameters for organic morphing
  phaseX: number;
  phaseY: number;
  phaseR: number;
  freqX: number;
  freqY: number;
  freqR: number;
}

interface Cloud {
  baseX: number; // in grid cells
  y: number;     // in grid cells
  speed: number; // grid cells per second
  opacity: number;
  puffs: CloudPuff[];
}

const CLOUD_COUNT = 10;

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
  private cloudBuffer: HTMLCanvasElement;
  private cloudBufCtx: CanvasRenderingContext2D;

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

    this.cloudBuffer = document.createElement("canvas");
    this.cloudBuffer.width = grid.width;
    this.cloudBuffer.height = grid.height;
    const cloudCtx = this.cloudBuffer.getContext("2d");
    if (!cloudCtx) throw new Error("2D context unavailable");
    this.cloudBufCtx = cloudCtx;

    this.clouds = this.generateClouds(grid.width, grid.height);
  }

  private generateClouds(gridW: number, gridH: number): Cloud[] {
    const clouds: Cloud[] = [];
    const wrap = gridW + 60;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const puffs: CloudPuff[] = [];
      const puffCount = 8 + Math.floor(Math.random() * 5);
      for (let p = 0; p < puffCount; p++) {
        puffs.push({
          dx: (Math.random() - 0.5) * 24,
          dy: (Math.random() - 0.5) * 4,
          r: 4 + Math.random() * 6,
          phaseX: Math.random() * Math.PI * 2,
          phaseY: Math.random() * Math.PI * 2,
          phaseR: Math.random() * Math.PI * 2,
          freqX: 0.15 + Math.random() * 0.2,
          freqY: 0.2 + Math.random() * 0.25,
          freqR: 0.1 + Math.random() * 0.15,
        });
      }
      clouds.push({
        baseX: Math.random() * wrap - 30,
        y: gridH * (0.06 + Math.random() * 0.32),
        speed: 0.6 + Math.random() * 1.0,
        opacity: 0.5 + Math.random() * 0.35,
        puffs,
      });
    }
    return clouds;
  }

  /** Paints a dusk sky gradient with pixelated drifting clouds. */
  private drawBackground(): void {
    const { width, height } = this.ctx.canvas;
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#241b4e");
    gradient.addColorStop(0.5, "#7a3f7d");
    gradient.addColorStop(1, "#f0824f");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);

    // Render clouds at grid resolution into the low-res buffer
    const gw = this.cloudBuffer.width;
    const gh = this.cloudBuffer.height;
    const cctx = this.cloudBufCtx;
    cctx.clearRect(0, 0, gw, gh);

    const t = performance.now() / 1000;
    const wrap = gw + 60;

    for (const cloud of this.clouds) {
      const cx = (((cloud.baseX + t * cloud.speed) % wrap) + wrap) % wrap - 30;

      // Bottom shadow — shifted down, darker
      cctx.fillStyle = `rgba(60, 40, 60, ${cloud.opacity * 0.3})`;
      for (const puff of cloud.puffs) {
        const ax = puff.dx + Math.sin(t * puff.freqX + puff.phaseX) * 1.5;
        const ay = puff.dy + Math.sin(t * puff.freqY + puff.phaseY) * 0.8;
        const ar = puff.r + Math.sin(t * puff.freqR + puff.phaseR) * 1.0;
        this.fillPixelCircle(cctx, cx + ax, cloud.y + ay + 1.5, ar * 1.05, gw, gh);
      }

      // Main cloud body
      cctx.fillStyle = `rgba(255, 248, 240, ${cloud.opacity})`;
      for (const puff of cloud.puffs) {
        const ax = puff.dx + Math.sin(t * puff.freqX + puff.phaseX) * 1.5;
        const ay = puff.dy + Math.sin(t * puff.freqY + puff.phaseY) * 0.8;
        const ar = puff.r + Math.sin(t * puff.freqR + puff.phaseR) * 1.0;
        this.fillPixelCircle(cctx, cx + ax, cloud.y + ay, ar, gw, gh);
      }

      // Top highlight — shifted up, smaller, brighter
      cctx.fillStyle = `rgba(255, 255, 255, ${cloud.opacity * 0.35})`;
      for (const puff of cloud.puffs) {
        const ax = puff.dx + Math.sin(t * puff.freqX + puff.phaseX) * 1.5;
        const ay = puff.dy + Math.sin(t * puff.freqY + puff.phaseY) * 0.8;
        const ar = puff.r + Math.sin(t * puff.freqR + puff.phaseR) * 1.0;
        this.fillPixelCircle(cctx, cx + ax, cloud.y + ay - 1, ar * 0.6, gw, gh);
      }
    }

    // Blit the cloud buffer scaled up with nearest-neighbor
    this.ctx.drawImage(this.cloudBuffer, 0, 0, width, height);
  }

  /** Fills a circle as discrete pixel rects at grid resolution. */
  private fillPixelCircle(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, r: number,
    gw: number, gh: number,
  ): void {
    const r2 = r * r;
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    for (let py = y0; py <= y1; py++) {
      if (py < 0 || py >= gh) continue;
      for (let px = x0; px <= x1; px++) {
        if (px < 0 || px >= gw) continue;
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) {
          ctx.fillRect(px, py, 1, 1);
        }
      }
    }
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
      // Wet dirt gets progressively darker based on moisture (vx 0-8)
      const wetOffset = id === MaterialId.Dirt ? -(grid.vx[i] * 5) : 0;
      // Darken bottom edge of dirt (where dirt meets non-dirt/non-grass below)
      let edgeOffset = 0;
      if ((id === MaterialId.Dirt || id === MaterialId.Grass) && i + grid.width < grid.ids.length) {
        const belowId = grid.ids[i + grid.width] as MaterialId;
        if (belowId !== MaterialId.Dirt && belowId !== MaterialId.Grass) {
          edgeOffset = -40;
        }
      }
      data[o] = clamp(color[0] + shade + wetOffset + edgeOffset);
      data[o + 1] = clamp(color[1] + shade + wetOffset + edgeOffset);
      data[o + 2] = clamp(color[2] + shade + wetOffset + edgeOffset);
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
    this.drawFaucetDials(grid);
  }

  /** Draws a small flow-state dial on each faucet body. */
  private drawFaucetDials(grid: Grid): void {
    const cs = this.cellSize;
    const ids = grid.ids;
    const visited = new Uint8Array(grid.width * grid.height);

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const idx = y * grid.width + x;
        if (visited[idx]) continue;
        if ((ids[idx] as MaterialId) !== MaterialId.Faucet) continue;

        // Flood-fill to find this faucet's bounding box
        let minX = x, maxX = x, minY = y, maxY = y;
        const queue: [number, number][] = [[x, y]];
        visited[idx] = 1;
        let flowState = grid.vx[idx];
        while (queue.length > 0) {
          const [cx, cy] = queue.shift()!;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!grid.inBounds(nx, ny)) continue;
            const ni = ny * grid.width + nx;
            if (visited[ni]) continue;
            if ((ids[ni] as MaterialId) === MaterialId.Faucet) {
              visited[ni] = 1;
              queue.push([nx, ny]);
            }
          }
        }

        // Draw dial at center of faucet body
        const centerX = ((minX + maxX + 1) / 2) * cs;
        const centerY = ((minY + maxY + 1) / 2) * cs;
        const radius = Math.min((maxX - minX + 1), (maxY - minY + 1)) * cs * 0.28;

        this.ctx.save();

        // Dial background
        this.ctx.fillStyle = "#1a1a2a";
        this.ctx.strokeStyle = "#555";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();

        // Dial needle — points to position based on state (0=left, 1=up, 2=right)
        const needleAngle = -Math.PI / 2 + (flowState - 1) * (Math.PI / 3);
        const needleLen = radius * 0.7;
        const colors = ["#888", "#4091eb", "#40d8eb"];
        this.ctx.strokeStyle = colors[flowState] ?? "#888";
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(centerX, centerY);
        this.ctx.lineTo(
          centerX + Math.cos(needleAngle) * needleLen,
          centerY + Math.sin(needleAngle) * needleLen,
        );
        this.ctx.stroke();

        // Center dot
        this.ctx.fillStyle = "#aaa";
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, 1.5, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
      }
    }
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

  /** Draws a highlight outline around a set of grid-index cells (e.g. a hovered flower cluster). */
  drawClusterOutline(grid: Grid, cluster: Set<number>): void {
    const cs = this.cellSize;
    this.ctx.save();
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    for (const idx of cluster) {
      const x = idx % grid.width;
      const y = Math.floor(idx / grid.width);
      const left = x * cs;
      const top = y * cs;
      const right = left + cs;
      const bottom = top + cs;

      // Draw only boundary edges (where the neighbor is NOT in the cluster)
      if (!cluster.has(idx - grid.width)) {
        this.ctx.moveTo(left, top);
        this.ctx.lineTo(right, top);
      }
      if (!cluster.has(idx + grid.width)) {
        this.ctx.moveTo(left, bottom);
        this.ctx.lineTo(right, bottom);
      }
      if (!cluster.has(idx - 1) || x === 0) {
        this.ctx.moveTo(left, top);
        this.ctx.lineTo(left, bottom);
      }
      if (!cluster.has(idx + 1) || x === grid.width - 1) {
        this.ctx.moveTo(right, top);
        this.ctx.lineTo(right, bottom);
      }
    }
    this.ctx.stroke();
    this.ctx.restore();
  }

  /** Draws a garden shears sprite at the given canvas-pixel position.
   *  @param openness 0 = blades closed, 1 = fully open (default). */
  drawShears(px: number, py: number, openness: number = 1): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(1.5, 1.5);
    // Offset so the sprite top-center aligns with the mouse position
    ctx.translate(-8, 0);

    const pivotX = 8;
    const pivotY = 17;
    // Each blade/handle rotates up to ~0.3 rad from center; openness controls spread
    const angle = openness * 0.3;

    ctx.strokeStyle = "#222";
    ctx.lineWidth = 1;

    // Left blade (rotated clockwise when open)
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(-angle);
    ctx.translate(-pivotX, -pivotY);
    ctx.fillStyle = "#c0c0c0";
    ctx.beginPath();
    ctx.moveTo(4, 0);
    ctx.lineTo(10, 16);
    ctx.lineTo(7, 18);
    ctx.lineTo(2, 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Right blade (rotated counter-clockwise when open)
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle);
    ctx.translate(-pivotX, -pivotY);
    ctx.fillStyle = "#ddd";
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(6, 16);
    ctx.lineTo(9, 18);
    ctx.lineTo(14, 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Pivot
    ctx.fillStyle = "#666";
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Left handle (rotates opposite to left blade — handles spread when blades close)
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle);
    ctx.translate(-pivotX, -pivotY);
    ctx.fillStyle = "#d06030";
    ctx.beginPath();
    ctx.moveTo(6, 19);
    ctx.quadraticCurveTo(2, 26, 0, 32);
    ctx.quadraticCurveTo(-1, 35, 1, 35);
    ctx.quadraticCurveTo(4, 34, 6, 28);
    ctx.lineTo(8, 21);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Right handle (rotates opposite to right blade)
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(-angle);
    ctx.translate(-pivotX, -pivotY);
    ctx.fillStyle = "#b84820";
    ctx.beginPath();
    ctx.moveTo(10, 19);
    ctx.quadraticCurveTo(14, 26, 16, 32);
    ctx.quadraticCurveTo(17, 35, 15, 35);
    ctx.quadraticCurveTo(12, 34, 10, 28);
    ctx.lineTo(8, 21);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();
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
