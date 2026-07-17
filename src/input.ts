import { Grid, MATERIALS, MaterialId, allocateObjectId, createDefaultFallingObjectState, harvestFlowerCluster } from "@particle-sim/shared";
import { state, hasPickaxeEquipped, addToHotbar, getActiveHotbarMaterial, removeFromActiveSlot, getLocalPlayer } from "./state";
import { startSwing, setSwingHeld } from "./character";

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
          grid.setFaucetFlow(x, y, 1);
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
    const current = grid.getFaucetFlow(gx, gy);
    const next = (current + 1) % 3;
    for (const [x, y] of cells) {
      grid.setFaucetFlow(x, y, next);
    }
    return true;
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

      // Some objects (torches, stones) placed in the air fall to the ground
      // with an animation instead of snapping into place.
      const fallsWhenAirborne =
        materialId === MaterialId.Torch || materialId === MaterialId.Stone;
      if (fallsWhenAirborne) {
        const offsets: [number, number][] = [];
        for (let dy = -Math.floor(halfH); dy < height - Math.floor(halfH); dy++) {
          for (let dx = -Math.floor(halfW); dx < width - Math.floor(halfW); dx++) {
            if (shape === "circle" && (dx / halfW) ** 2 + (dy / halfH) ** 2 > 1) continue;
            offsets.push([dx, dy]);
          }
        }
        const footFits = (cy: number) =>
          offsets.every(([dx, dy]) => {
            const x = gx + dx;
            const y = cy + dy;
            return grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Empty;
          });
        let restY = gy;
        while (footFits(restY + 1)) restY++;
        if (restY > gy) {
          // Animate the fall; the object is stamped into the grid on landing.
          const objectId = allocateObjectId(state.world);
          state.world.fallingObjects[objectId] = createDefaultFallingObjectState(objectId, materialId, gx, gy, restY, 0, offsets);
          return;
        }
      }

      for (let dy = -Math.floor(halfH); dy < height - Math.floor(halfH); dy++) {
        for (let dx = -Math.floor(halfW); dx < width - Math.floor(halfW); dx++) {
          if (shape === "circle" && (dx / halfW) ** 2 + (dy / halfH) ** 2 > 1) continue;
          const x = gx + dx;
          const y = gy + dy;
          if (!grid.inBounds(x, y)) continue;
          if (!canPlaceOver(x, y, materialId)) continue;
          grid.set(x, y, materialId);
          if (materialId === MaterialId.Faucet) grid.setFaucetFlow(x, y, 1);
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
      getLocalPlayer().inventory.flowers += harvested;
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
      // Mining now happens continuously along the pickaxe arc during the swing
      // (see mineSwingArc in character.ts). Holding the button auto-repeats swings.
      if (state.character) {
        startSwing(state.character);
        setSwingHeld(state.character, true);
      }
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
    if (state.character) setSwingHeld(state.character, false);
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
