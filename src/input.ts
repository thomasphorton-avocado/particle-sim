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
      }
    }
  };

  const start = (clientX: number, clientY: number) => {
    const pos = toGrid(clientX, clientY);
    // Clicking a bloomed flower harvests it instead of painting
    if (harvestFlowerCluster(grid, pos.x, pos.y)) {
      state.inventory.flowers++;
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
