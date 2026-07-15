import { Grid } from "./grid";
import { MATERIALS, MaterialId } from "./materials";
import { harvestFlowerCluster } from "./harvest";
import { state, hasPickaxeEquipped, addToHotbar, getActiveHotbarMaterial, removeFromActiveSlot } from "./state";
import { startSwing } from "./character";

/** Maximum placement distance from character center (in grid cells). */
const PLACEMENT_RADIUS = 30;

/** Returns true if the grid position is within placement range of the character. */
function withinPlacementRange(gx: number, gy: number): boolean {
  if (state.toolMode === "editor") return true; // editor ignores radius
  const char = state.character;
  if (!char) return true;
  const cx = char.x + char.width / 2;
  const cy = char.y + char.height / 2;
  const dx = gx - cx;
  const dy = gy - cy;
  return dx * dx + dy * dy <= PLACEMENT_RADIUS * PLACEMENT_RADIUS;
}

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

  /** Returns true if placing `matId` can overwrite what's currently at (x, y). */
  const canPlaceOver = (x: number, y: number, matId: MaterialId): boolean => {
    const existing = grid.get(x, y);
    if (existing === MaterialId.Empty) return true;
    if (matId === MaterialId.Empty) return true;
    // Impermeable materials displace water
    if (existing === MaterialId.Water && !MATERIALS[matId].permeable) return true;
    return false;
  };

  const paintAt = (gx: number, gy: number) => {
    if (!withinPlacementRange(gx, gy)) return;
    const r = state.brushSize;
    const material = state.selectedMaterial;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (!grid.inBounds(x, y)) continue;
        if (!withinPlacementRange(x, y)) continue;
        if (canPlaceOver(x, y, material)) {
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
    if (!withinPlacementRange(gx, gy)) return;
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
        if (!withinPlacementRange(x, y)) continue;
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

  /** Mine a small area in front of the character, matching the pickaxe arc. */
  const mineInFront = () => {
    const char = state.character;
    if (!char) return;

    let mineW: number, mineH: number, baseX: number, baseY: number;

    if (char.crouching) {
      mineW = 5;
      mineH = 5;
      baseX = char.facing === 1
        ? Math.floor(char.x + char.width) - 1
        : Math.floor(char.x) - mineW + 1;
      baseY = Math.floor(char.y + char.height);
    } else if (char.lookingUp) {
      mineW = 5;
      mineH = 5;
      baseX = Math.floor(char.x + char.width / 2) - 2;
      baseY = Math.floor(char.y) - mineH;
    } else {
      mineW = 4;
      mineH = char.height + 3;
      baseX = char.facing === 1
        ? Math.floor(char.x + char.width)
        : Math.floor(char.x) - mineW;
      baseY = Math.floor(char.y) - 3;
    }

    // Track which cells have already been mined (to avoid double-counting flood-filled objects)
    const mined = new Set<number>();
    const cellKey = (x: number, y: number) => y * grid.width + x;

    for (let dy = 0; dy < mineH; dy++) {
      for (let dx = 0; dx < mineW; dx++) {
        const x = baseX + dx;
        const y = baseY + dy;
        if (!grid.inBounds(x, y)) continue;
        if (mined.has(cellKey(x, y))) continue;
        const id = grid.get(x, y) as MaterialId;
        if (id === MaterialId.Empty || id === MaterialId.Water) continue;
        const mat = MATERIALS[id];

        // Object-type materials: flood-fill to remove the whole object as one item
        if (mat.placement.kind === "object") {
          const queue: [number, number][] = [[x, y]];
          mined.add(cellKey(x, y));
          while (queue.length > 0) {
            const [cx, cy] = queue.shift()!;
            grid.set(cx, cy, MaterialId.Empty);
            grid.markUpdated(cx, cy);
            for (const [nx, ny] of [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]] as const) {
              if (!grid.inBounds(nx, ny)) continue;
              const k = cellKey(nx, ny);
              if (mined.has(k)) continue;
              if (grid.get(nx, ny) === id) {
                mined.add(k);
                queue.push([nx, ny]);
              }
            }
          }
          // One item per whole object
          addToHotbar(id);
          const name = mat.name.toLowerCase();
          state.inventory[name] = (state.inventory[name] || 0) + 1;
          continue;
        }

        mined.add(cellKey(x, y));
        const name = mat.name.toLowerCase();
        state.inventory[name] = (state.inventory[name] || 0) + 1;
        // Add minable materials to hotbar (skip non-placeable things like stems/flowers/grass)
        if (id !== MaterialId.Stem && id !== MaterialId.Flower && id !== MaterialId.Grass) {
          addToHotbar(id);
        }
        grid.set(x, y, MaterialId.Empty);
        grid.markUpdated(x, y);
      }
    }
  };

  /** Place a single cell from the active hotbar material slot. */
  const placeFromHotbar = (gx: number, gy: number) => {
    const hotbarMat = getActiveHotbarMaterial();
    if (!hotbarMat) return;
    if (!withinPlacementRange(gx, gy)) return;

    const materialId = hotbarMat.materialId;
    const matDef = MATERIALS[materialId];

    if (matDef.placement.kind === "object") {
      const { shape, width, height } = matDef.placement;
      const halfW = width / 2;
      const halfH = height / 2;
      // Check all cells are in range first
      for (let dy = -Math.floor(halfH); dy < height - Math.floor(halfH); dy++) {
        for (let dx = -Math.floor(halfW); dx < width - Math.floor(halfW); dx++) {
          if (shape === "circle" && (dx / halfW) ** 2 + (dy / halfH) ** 2 > 1) continue;
          const x = gx + dx;
          const y = gy + dy;
          if (!grid.inBounds(x, y) || !withinPlacementRange(x, y)) return;
        }
      }
      // Consume one item for the whole object
      if (!removeFromActiveSlot()) return;
      for (let dy = -Math.floor(halfH); dy < height - Math.floor(halfH); dy++) {
        for (let dx = -Math.floor(halfW); dx < width - Math.floor(halfW); dx++) {
          if (shape === "circle" && (dx / halfW) ** 2 + (dy / halfH) ** 2 > 1) continue;
          const x = gx + dx;
          const y = gy + dy;
          if (!grid.inBounds(x, y)) continue;
          if (!canPlaceOver(x, y, materialId)) continue;
          grid.set(x, y, materialId);
          if (materialId === MaterialId.Faucet) grid.setVx(x, y, 1);
        }
      }
    } else {
      // Brush-paint
      const r = state.brushSize;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const x = gx + dx;
          const y = gy + dy;
          if (!grid.inBounds(x, y)) continue;
          if (!withinPlacementRange(x, y)) continue;
          if (!canPlaceOver(x, y, materialId)) continue;
          if (!removeFromActiveSlot()) return; // ran out
          grid.set(x, y, materialId);
        }
      }
    }
  };

  const start = (clientX: number, clientY: number) => {
    const pos = toGrid(clientX, clientY);
    // Clicking a faucet cycles its flow state
    if (cycleFaucet(pos.x, pos.y)) return;
    // Clicking a bloomed flower harvests it instead of painting
    const harvested = harvestFlowerCluster(grid, pos.x, pos.y);
    if (harvested > 0) {
      state.inventory.flowers += harvested;
      // Add seeds to hotbar (1 per bloom + 10% chance of bonus seed)
      for (let i = 0; i < harvested; i++) {
        addToHotbar(MaterialId.Seed);
        if (Math.random() < 0.1) addToHotbar(MaterialId.Seed);
      }
      if (state.hoverPixel) {
        state.snip = { px: state.hoverPixel.x, py: state.hoverPixel.y, startTime: performance.now() };
      }
      return;
    }
    if (state.toolMode === "play" && hasPickaxeEquipped()) {
      mineInFront();
      if (state.character) startSwing(state.character);
      painting = false;
      lastGridPos = null;
      return;
    }
    // Place from hotbar material slot (works in play mode)
    if (state.toolMode === "play" && getActiveHotbarMaterial()) {
      placeFromHotbar(pos.x, pos.y);
      painting = false;
      lastGridPos = null;
      return;
    }
    // In play mode, don't allow free painting — must use inventory
    if (state.toolMode === "play") return;
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
