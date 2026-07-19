import { Grid, FLOWER_PALETTE, MATERIALS, MaterialId } from "@particle-sim/shared";
import type { ObjectPlacement } from "@particle-sim/shared";
import type { PresentationSnapshot } from "./render-snapshots";
import { state } from "./state";

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
          dx: (Math.random() - 0.5) * 30,
          dy: (Math.random() - 0.5) * 5,
          r: 5 + Math.random() * 7.5,
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

  /** Paints a day/night sky gradient with pixelated drifting clouds. */
  private drawBackground(): void {
    const { width, height } = this.ctx.canvas;
    const phase = (state.world.time.dayNightCycle % 1 + 1) % 1;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const ease = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;

    // Full sky gradients (top / mid / bottom) for each key time of day.
    // Keyframes are evenly spaced around the cycle at phases 0, 0.25, 0.5, 0.75.
    type SkyGradient = { top: [number, number, number]; mid: [number, number, number]; bottom: [number, number, number] };
    const keyframes: SkyGradient[] = [
      // Morning — soft dawn: cool blue overhead melting into a warm peach horizon
      { top: [74, 120, 178], mid: [196, 156, 180], bottom: [248, 196, 146] },
      // Day — bright, crisp blue sky with a pale hazy horizon
      { top: [78, 150, 224], mid: [136, 196, 242], bottom: [200, 232, 250] },
      // Dusk — sunset: deep indigo up top through rose to a glowing orange horizon
      { top: [44, 40, 96], mid: [166, 80, 126], bottom: [240, 126, 66] },
      // Night — dark blue/purple, a touch lighter near the horizon
      { top: [12, 16, 44], mid: [24, 26, 66], bottom: [40, 40, 86] },
    ];

    const scaled = phase * keyframes.length;
    const idx = Math.floor(scaled) % keyframes.length;
    const nextIdx = (idx + 1) % keyframes.length;
    const blendT = ease(scaled - Math.floor(scaled));
    const from = keyframes[idx];
    const to = keyframes[nextIdx];
    const blend = (band: keyof SkyGradient): string => {
      const a = from[band];
      const b = to[band];
      const r = Math.round(lerp(a[0], b[0], blendT));
      const g = Math.round(lerp(a[1], b[1], blendT));
      const bl = Math.round(lerp(a[2], b[2], blendT));
      return `rgb(${r}, ${g}, ${bl})`;
    };

    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, blend("top"));
    gradient.addColorStop(0.5, blend("mid"));
    gradient.addColorStop(1, blend("bottom"));
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);

    // Render clouds at grid resolution into the low-res buffer
    const gw = this.cloudBuffer.width;
    const gh = this.cloudBuffer.height;
    const cctx = this.cloudBufCtx;
    cctx.clearRect(0, 0, gw, gh);

    const t = performance.now() / 1000;
    const wrap = gw + 60;
    const nightStrength = this.nightStrength();
    const cloudVisibility = 0.35 + 0.65 * (1 - nightStrength * 0.6);

    for (const cloud of this.clouds) {
      const cx = (((cloud.baseX + t * cloud.speed) % wrap) + wrap) % wrap - 30;

      // Bottom shadow — shifted down, darker
      cctx.fillStyle = `rgba(40, 25, 50, ${cloud.opacity * 0.45 * cloudVisibility})`;
      for (const puff of cloud.puffs) {
        const ax = puff.dx + Math.sin(t * puff.freqX + puff.phaseX) * 1.5;
        const ay = puff.dy + Math.sin(t * puff.freqY + puff.phaseY) * 0.8;
        const ar = puff.r + Math.sin(t * puff.freqR + puff.phaseR) * 1.0;
        this.fillPixelCircle(cctx, cx + ax, cloud.y + ay + 2.5, ar * 1.1, gw, gh);
      }

      // Main cloud body
      cctx.fillStyle = `rgba(255, 248, 240, ${cloud.opacity * cloudVisibility})`;
      for (const puff of cloud.puffs) {
        const ax = puff.dx + Math.sin(t * puff.freqX + puff.phaseX) * 1.5;
        const ay = puff.dy + Math.sin(t * puff.freqY + puff.phaseY) * 0.8;
        const ar = puff.r + Math.sin(t * puff.freqR + puff.phaseR) * 1.0;
        this.fillPixelCircle(cctx, cx + ax, cloud.y + ay, ar, gw, gh);
      }

      // Top highlight — shifted up, smaller, brighter
      cctx.fillStyle = `rgba(255, 255, 255, ${cloud.opacity * 0.35 * cloudVisibility})`;
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
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    for (let py = y0; py <= y1; py++) {
      if (py < 0 || py >= gh) continue;
      const dy = py + 0.5 - cy;
      const halfWidth = Math.sqrt(Math.max(0, r2 - dy * dy));
      const start = Math.max(0, Math.ceil(cx - halfWidth - 0.5));
      const end = Math.min(gw - 1, Math.floor(cx + halfWidth - 0.5));
      if (start <= end) ctx.fillRect(start, py, end - start + 1, 1);
    }
  }

  getCtx(): CanvasRenderingContext2D {
    return this.ctx;
  }

  draw(grid: Grid, presentationSnapshot?: PresentationSnapshot): void {
    const data = this.imageData.data;
    for (let i = 0; i < grid.ids.length; i++) {
      const id = grid.ids[i] as MaterialId;
      const material = MATERIALS[id];
      const shade = grid.shade[i];
      const o = i * 4;
      // Flowers store their randomly-chosen bloom color's palette index in material-specific auxiliary state.
      const color = id === MaterialId.Flower ? FLOWER_PALETTE[grid.getFlowerPalette(Math.floor(i % grid.width), Math.floor(i / grid.width))] : material.color;
      // Wet dirt gets progressively darker based on moisture (0-12)
      const wetOffset = id === MaterialId.Dirt ? -(grid.getDirtMoisture(Math.floor(i % grid.width), Math.floor(i / grid.width)) * 5) : 0;
      // Darken bottom edge (where material meets different/empty below)
      let edgeOffset = 0;
      if ((id === MaterialId.Dirt || id === MaterialId.Grass || id === MaterialId.Stone || id === MaterialId.Wood) && i + grid.width < grid.ids.length) {
        const belowId = grid.ids[i + grid.width] as MaterialId;
        if (belowId !== id && belowId !== MaterialId.Dirt && belowId !== MaterialId.Grass) {
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

    const nightStrength = this.nightStrength();
    if (nightStrength > 0) {
      this.ctx.fillStyle = `rgba(6, 10, 24, ${nightStrength * 0.45})`;
      this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    }

    this.drawTorchLights(grid);
    this.drawTorchHandles(grid);
    this.drawTorchFlames(grid);
    this.drawFallingObjects(presentationSnapshot);
    this.drawClockFaces(grid);
    this.drawObjectOutlines(grid);
    this.drawFaucetDials(grid);
  }

  /**
   * Darkness factor for the current time: 0 at midday (phase 0.25),
   * 1 at midnight (phase 0.75), easing smoothly through dawn and dusk.
   */
  private nightStrength(): number {
    const phase = (state.world.time.dayNightCycle % 1 + 1) % 1;
    return (1 - Math.cos(2 * Math.PI * (phase - 0.25))) / 2;
  }

  /**
   * Draw a wooden handle hanging a few blocks below each torch. Anchored at the
   * bottom-center of each torch cluster (a cell with torches left & right but not
   * below), so a 3×3 torch gets exactly one handle.
   */
  private drawTorchHandles(grid: Grid): void {
    const cs = this.cellSize;
    const isTorch = (x: number, y: number) =>
      grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Torch;

    this.ctx.save();
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (!isTorch(x, y)) continue;
        // Only the bottom-center cell of a torch cluster anchors the handle.
        if (!isTorch(x - 1, y) || !isTorch(x + 1, y) || isTorch(x, y + 1)) continue;
        this.drawTorchHandleAt(x * cs + cs / 2, y * cs + cs * 0.5);
      }
    }
    this.ctx.restore();
  }

  /** Handle body at a pixel anchor (center x, top y). */
  private drawTorchHandleAt(cx: number, topY: number): void {
    const cs = this.cellSize;
    const w = cs * 0.9;
    const len = cs * 3.5; // a few blocks below
    this.ctx.fillStyle = "#5a3a1a";
    this.ctx.fillRect(cx - w / 2, topY, w, len);
    this.ctx.fillStyle = "#7a5223";
    this.ctx.fillRect(cx - w / 2, topY, Math.max(1, w * 0.3), len);
  }

  /**
   * Draw a defined layered flame on top of the glow, anchored at the top-center
   * of each torch cluster (torches left & right but none above).
   */
  private drawTorchFlames(grid: Grid): void {
    const cs = this.cellSize;
    const isTorch = (x: number, y: number) =>
      grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Torch;

    this.ctx.save();
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (!isTorch(x, y)) continue;
        // Only the top-center cell of a torch cluster anchors the flame.
        if (!isTorch(x - 1, y) || !isTorch(x + 1, y) || isTorch(x, y - 1)) continue;
        this.drawTorchFlameAt(x * cs + cs / 2, y * cs + cs * 0.6);
      }
    }
    this.ctx.restore();
  }

  /** Layered flame at a pixel center. */
  private drawTorchFlameAt(cx: number, cy: number): void {
    const cs = this.cellSize;
    const TWO_PI = Math.PI * 2;
    // Outer flame (deep orange)
    this.ctx.fillStyle = "#d1531a";
    this.ctx.beginPath();
    this.ctx.ellipse(cx, cy, cs * 0.95, cs * 1.5, 0, 0, TWO_PI);
    this.ctx.fill();
    // Mid flame (bright orange)
    this.ctx.fillStyle = "#ff9a2e";
    this.ctx.beginPath();
    this.ctx.ellipse(cx, cy + cs * 0.25, cs * 0.6, cs * 1.05, 0, 0, TWO_PI);
    this.ctx.fill();
    // Inner core (yellow-white)
    this.ctx.fillStyle = "#ffe9a8";
    this.ctx.beginPath();
    this.ctx.ellipse(cx, cy + cs * 0.4, cs * 0.32, cs * 0.62, 0, 0, TWO_PI);
    this.ctx.fill();
  }

  private drawTorchLights(grid: Grid): void {
    const cs = this.cellSize;
    const isTorch = (x: number, y: number) =>
      grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Torch;
    this.ctx.save();
    this.ctx.globalCompositeOperation = "screen";
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (!isTorch(x, y)) continue;
        // Emit one glow per torch, centered on the flame (top-center cell).
        if (!isTorch(x - 1, y) || !isTorch(x + 1, y) || isTorch(x, y - 1)) continue;
        this.drawTorchGlowAt(x * cs + cs / 2, y * cs + cs * 0.6);
      }
    }
    this.ctx.restore();
  }

  /** Radial glow centered on a flame pixel position (caller sets screen blend). */
  private drawTorchGlowAt(px: number, py: number): void {
    const cs = this.cellSize;
    const nightStrength = this.nightStrength();
    const glowStrength = 0.25 + nightStrength * 0.75;
    // Intensity boost (increase by 200% → ~3× the glow opacity), clamped to 1.
    const boost = 3;
    const a = (v: number) => Math.min(1, v * boost);
    const radius = cs * (12 + nightStrength * 4);
    const gradient = this.ctx.createRadialGradient(px, py, cs * 1.2, px, py, radius);
    gradient.addColorStop(0, `rgba(255, 240, 180, ${a(0.18 + glowStrength * 0.5)})`);
    gradient.addColorStop(0.25, `rgba(255, 190, 90, ${a(0.1 + glowStrength * 0.32)})`);
    gradient.addColorStop(0.6, `rgba(255, 140, 40, ${a(0.04 + glowStrength * 0.16)})`);
    gradient.addColorStop(1, "rgba(255, 120, 30, 0)");
    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.arc(px, py, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /**
   * Draw objects that are mid-fall (not yet in the grid) at their animated
   * position. Torches also get their glow/handle/flame overlays so they look
   * identical to placed torches during the fall.
   */
  private drawFallingObjects(presentationSnapshot?: PresentationSnapshot): void {
    const cs = this.cellSize;
    const snapshotObjects = presentationSnapshot?.fallingObjects;
    const items = snapshotObjects
      ? Array.from(snapshotObjects.entries()).map(([id, object]) => ({ id, ...object }))
      : Object.values(state.world.fallingObjects);

    for (const object of items) {
      const materialId = object.materialId as MaterialId;
      const [r, g, b] = MATERIALS[materialId].color;
      this.ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      for (const [dx, dy] of object.offsets) {
        this.ctx.fillRect((object.x + dx) * cs, (object.y + dy) * cs, cs, cs);
      }

      if (object.materialId === MaterialId.Torch) {
        const flameCx = object.x * cs + cs / 2;
        const flameCy = (object.y - 1) * cs + cs * 0.6;
        this.ctx.save();
        this.ctx.globalCompositeOperation = "screen";
        this.drawTorchGlowAt(flameCx, flameCy);
        this.ctx.restore();
        this.drawTorchHandleAt(object.x * cs + cs / 2, (object.y + 1) * cs + cs * 0.5);
        this.drawTorchFlameAt(flameCx, flameCy);
      }
    }
  }


  private drawClockFaces(grid: Grid): void {
    const cs = this.cellSize;
    const cycle = state.world.time.dayNightCycle % 1;
    const angle = (cycle * Math.PI * 2 + Math.PI / 2) % (Math.PI * 2);
    const handLength = cs * 4.2;

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.get(x, y) !== MaterialId.Clock) continue;
        const px = x * cs + cs / 2;
        const py = y * cs + cs / 2;
        this.ctx.save();
        this.ctx.translate(px, py);
        this.ctx.beginPath();
        this.ctx.arc(0, 0, cs * 2.4, 0, Math.PI * 2);
        this.ctx.fillStyle = "#f8f3e4";
        this.ctx.fill();
        this.ctx.strokeStyle = "#4a4032";
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.lineTo(Math.sin(angle) * handLength, -Math.cos(angle) * handLength);
        this.ctx.strokeStyle = "#2f2a24";
        this.ctx.lineWidth = 4.5;
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
        this.ctx.fillStyle = "#2f2a24";
        this.ctx.fill();
        this.ctx.restore();
      }
    }
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
        let flowState = grid.getFaucetFlow(x, y);
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
        // Skip stone and wood — they use bottom-edge shading instead.
        // Skip torch — it has its own flame/glow/handle rendering.
        if (id === MaterialId.Stone || id === MaterialId.Wood || id === MaterialId.Torch) continue;

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

  /**
   * Draw an inventory placement preview: material-colored cells tinted
   * green (in range) or red (out of range).
   */
  drawInventoryPreview(
    gx: number,
    gy: number,
    materialId: MaterialId,
    charCx: number,
    charCy: number,
    placementRadius: number,
    brushSize: number,
  ): void {
    const cs = this.cellSize;
    const mat = MATERIALS[materialId];
    const [mr, mg, mb] = mat.color;

    this.ctx.save();
    if (mat.placement.kind === "object") {
      const { shape, width, height } = mat.placement;
      const halfW = width / 2;
      const halfH = height / 2;
      // Check if ALL cells are in range
      let allInRange = true;
      const cells: [number, number][] = [];
      for (let dy = -Math.floor(halfH); dy < height - Math.floor(halfH); dy++) {
        for (let dx = -Math.floor(halfW); dx < width - Math.floor(halfW); dx++) {
          if (shape === "circle" && (dx / halfW) ** 2 + (dy / halfH) ** 2 > 1) continue;
          const cx = gx + dx;
          const cy = gy + dy;
          cells.push([cx, cy]);
          const ddx = cx - charCx;
          const ddy = cy - charCy;
          if (ddx * ddx + ddy * ddy > placementRadius * placementRadius) allInRange = false;
        }
      }
      const tint = allInRange ? [0, 180, 0] : [200, 0, 0];
      const r = Math.round((mr + tint[0]) / 2);
      const g = Math.round((mg + tint[1]) / 2);
      const b = Math.round((mb + tint[2]) / 2);
      this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
      for (const [cx, cy] of cells) {
        this.ctx.fillRect(cx * cs, cy * cs, cs, cs);
      }
    } else {
      const rad = brushSize;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          const cx = gx + dx;
          const cy = gy + dy;
          const ddx = cx - charCx;
          const ddy = cy - charCy;
          const inRange = ddx * ddx + ddy * ddy <= placementRadius * placementRadius;
          const tint = inRange ? [0, 180, 0] : [200, 0, 0];
          const r = Math.round((mr + tint[0]) / 2);
          const g = Math.round((mg + tint[1]) / 2);
          const b = Math.round((mb + tint[2]) / 2);
          this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
          this.ctx.fillRect(cx * cs, cy * cs, cs, cs);
        }
      }
    }
    this.ctx.restore();
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
