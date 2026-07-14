import { Grid } from "./grid";
import { MATERIALS, MaterialId } from "./materials";
import { harvestFlowerCluster } from "./harvest";
import { state } from "./state";

/** Wires pointer events on `canvas` to paint or stamp the selected material into `grid`. */
export function attachInput(canvas: HTMLCanvasElement, grid: Grid, cellSize: number): void {
  let painting = false;
  let lastGridPos: { x: number; y: number } | null = null;

  const toGrid = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (clientX - rect.left) * scaleX;
    const py = (clientY - rect.top) * scaleY;
    state.hoverPixel = { x: px, y: py };
    return { x: Math.floor(px / cellSize), y: Math.floor(py / cellSize) };
  };

  const paintAt = (gx: number, gy: number) => {
    const r = state.brushSize;
    const material = state.selectedMaterial;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (!grid.inBounds(x, y)) continue;
        if (material === MaterialId.Empty || grid.get(x, y) === MaterialId.Empty) {
          grid.set(x, y, material);
        }
      }
    }
  };

  // Paint along the segment from the last known position so fast drags leave a solid stroke.
  const paintLine = (from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    if (!from) {
      paintAt(to.x, to.y);
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let i = 0; i <= steps; i++) {
      paintAt(Math.round(from.x + (dx * i) / steps), Math.round(from.y + (dy * i) / steps));
    }
  };

  // Stamps a whole fixed-size shape centered on (gx, gy) in one shot, for materials
  // placed as discrete objects (e.g. a wood plank or a stone boulder) rather than painted.
  const stampObjectAt = (gx: number, gy: number) => {
    const material = MATERIALS[state.selectedMaterial];
    if (material.placement.kind !== "object") return;
    const { shape, width, height } = material.placement;
    const halfW = width / 2;
    const halfH = height / 2;
    for (let dy = -Math.floor(halfH); dy < height - Math.floor(halfH); dy++) {
      for (let dx = -Math.floor(halfW); dx < width - Math.floor(halfW); dx++) {
        if (shape === "circle" && (dx / halfW) ** 2 + (dy / halfH) ** 2 > 1) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (!grid.inBounds(x, y)) continue;
        grid.set(x, y, state.selectedMaterial);
        // Faucets start on low flow
        if (state.selectedMaterial === MaterialId.Faucet) {
          grid.setVx(x, y, 1);
        }
      }
    }
  };

  /** Flood-fill all connected faucet cells and cycle their flow state. */
  const cycleFaucet = (gx: number, gy: number): boolean => {
    if (grid.get(gx, gy) !== MaterialId.Faucet) return false;
    const visited = new Set<number>();
    const queue: [number, number][] = [[gx, gy]];
    const key = (x: number, y: number) => y * grid.width + x;
    visited.add(key(gx, gy));
    const cells: [number, number][] = [];
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      cells.push([x, y]);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!grid.inBounds(nx, ny)) continue;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        if (grid.get(nx, ny) === MaterialId.Faucet) {
          visited.add(k);
          queue.push([nx, ny]);
        }
      }
    }
    const current = grid.getVx(gx, gy);
    const next = (current + 1) % 3;
    for (const [x, y] of cells) {
      grid.setVx(x, y, next);
    }
    return true;
  };

  const start = (clientX: number, clientY: number) => {
    const pos = toGrid(clientX, clientY);
    // Clicking a faucet cycles its flow state
    if (cycleFaucet(pos.x, pos.y)) return;
    // Clicking a bloomed flower harvests it instead of painting
    const harvested = harvestFlowerCluster(grid, pos.x, pos.y);
    if (harvested > 0) {
      state.inventory.flowers += harvested;
      if (state.hoverPixel) {
        state.snip = { px: state.hoverPixel.x, py: state.hoverPixel.y, startTime: performance.now() };
      }
      return;
    }
    if (MATERIALS[state.selectedMaterial].placement.kind === "object") {
      stampObjectAt(pos.x, pos.y);
      painting = false;
      lastGridPos = null;
      return;
    }
    painting = true;
    paintLine(null, pos);
    lastGridPos = pos;
  };

  const move = (clientX: number, clientY: number) => {
    const pos = toGrid(clientX, clientY);
    state.hover = pos;
    if (!painting) return;
    paintLine(lastGridPos, pos);
    lastGridPos = pos;
  };

  const end = () => {
    painting = false;
    lastGridPos = null;
  };

  canvas.addEventListener("mousedown", (e) => start(e.clientX, e.clientY));
  canvas.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  canvas.addEventListener("mouseleave", () => {
    state.hover = null;
    state.hoverPixel = null;
  });
  window.addEventListener("mouseup", end);

  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    },
    { passive: false },
  );
  canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    },
    { passive: false },
  );
  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
}
