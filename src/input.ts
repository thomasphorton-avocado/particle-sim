import { Grid, MATERIALS, MaterialId, allocateObjectId, createCommandEnvelope, createDefaultFallingObjectState, enqueueCommand, findFlowerCluster, getNextActorSequence, harvestFlowerCluster, nextBool, placeWorldCell, type GameplayCommand, type WorldState } from "@particle-sim/shared";
import { state, hasPickaxeEquipped, addToHotbar, getActiveHotbarMaterial, removeFromActiveSlot, getLocalPlayer } from "./state";

/** Maximum placement distance from character center (in grid cells). */
const PLACEMENT_RADIUS = 30;

/** Returns true if the grid position is within placement range of the character. */
function withinPlacementRange(gx: number, gy: number): boolean {
  if (state.toolMode === "editor") return true; // editor ignores radius
  const player = getLocalPlayer();
  const cx = player.x + player.width / 2;
  const cy = player.y + player.height / 2;
  const dx = gx - cx;
  const dy = gy - cy;
  return dx * dx + dy * dy <= PLACEMENT_RADIUS * PLACEMENT_RADIUS;
}

function canPlaceOver(grid: Grid, x: number, y: number, matId: MaterialId): boolean {
  const existing = grid.get(x, y);
  if (existing === MaterialId.Empty) return true;
  if (matId === MaterialId.Empty) return true;
  // Impermeable materials displace water
  if (existing === MaterialId.Water && !MATERIALS[matId].permeable) return true;
  return false;
}

function enqueuePlayCommand(world: WorldState, command: GameplayCommand): void {
  const actorId = state.localPlayerId;
  const envelope = createCommandEnvelope(actorId, getNextActorSequence(world, actorId), world.tick, command);
  enqueueCommand(world, envelope);
}

function getObjectOffsets(materialId: MaterialId): [number, number][] {
  const matDef = MATERIALS[materialId];
  if (matDef.placement.kind !== "object") return [];
  const { shape, width, height } = matDef.placement;
  const halfW = width / 2;
  const halfH = height / 2;
  const offsets: [number, number][] = [];
  for (let dy = -Math.floor(halfH); dy < height - Math.floor(halfH); dy++) {
    for (let dx = -Math.floor(halfW); dx < width - Math.floor(halfW); dx++) {
      if (shape === "circle" && (dx / halfW) ** 2 + (dy / halfH) ** 2 > 1) continue;
      offsets.push([dx, dy]);
    }
  }
  return offsets;
}

function canPlaceObjectFootprint(world: WorldState, materialId: MaterialId, anchorX: number, anchorY: number, offsets: [number, number][]): boolean {
  if (offsets.length === 0) return false;
  const grid = world.grid;
  for (const [dx, dy] of offsets) {
    const x = anchorX + dx;
    const y = anchorY + dy;
    if (!grid.inBounds(x, y)) return false;
    if (!withinPlacementRange(x, y)) return false;
    if (!canPlaceOver(grid, x, y, materialId)) return false;
  }
  return true;
}

function canDescendObjectFootprint(world: WorldState, anchorX: number, anchorY: number, offsets: [number, number][]): boolean {
  if (offsets.length === 0) return false;
  const grid = world.grid;
  for (const [dx, dy] of offsets) {
    const x = anchorX + dx;
    const y = anchorY + dy;
    if (!grid.inBounds(x, y)) return false;
    if (grid.get(x, y) !== MaterialId.Empty) return false;
  }
  return true;
}

export function handleHarvestInputAt(world: WorldState, gx: number, gy: number): boolean {
  if (state.toolMode === "play") {
    const cluster = findFlowerCluster(world.grid, gx, gy);
    if (!cluster || cluster.size === 0) {
      return false;
    }
    const targetRevision = world.grid.cellRevisions[world.grid.index(gx, gy)] ?? 0;
    enqueuePlayCommand(world, { type: "harvest", x: gx, y: gy, expectedTargetRevision: targetRevision });
    return true;
  }

  const harvested = harvestFlowerCluster(world.grid, gx, gy);
  if (harvested <= 0) return false;

  const player = getLocalPlayer();
  player.inventory.flowers += harvested;
  for (let i = 0; i < harvested; i++) {
    addToHotbar(MaterialId.Seed);
    if (nextBool(world.random, 0.1)) addToHotbar(MaterialId.Seed);
  }
  if (state.hoverPixel) {
    state.snip = { px: state.hoverPixel.x, py: state.hoverPixel.y, startTime: performance.now() };
  }
  return true;
}

export function placeHotbarMaterialAt(world: WorldState, gx: number, gy: number): boolean {
  if (state.toolMode === "play") {
    const player = getLocalPlayer();
    enqueuePlayCommand(world, {
      type: "place",
      x: gx,
      y: gy,
      brushRadius: state.brushSize,
      expectedInventoryRevision: player.inventoryRevision,
      expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(gx, gy)] ?? 0,
    });
    return true;
  }

  const hotbarMat = getActiveHotbarMaterial();
  if (!hotbarMat) return false;
  if (!withinPlacementRange(gx, gy)) return false;

  const materialId = hotbarMat.materialId;
  const matDef = MATERIALS[materialId];
  const grid = world.grid;

  if (matDef.placement.kind === "object") {
    const offsets = getObjectOffsets(materialId);
    if (offsets.length === 0) return false;

    if (!canPlaceObjectFootprint(world, materialId, gx, gy, offsets)) {
      return false;
    }

    let restY = gy;
    const fallsWhenAirborne = materialId === MaterialId.Torch || materialId === MaterialId.Stone;
    if (fallsWhenAirborne) {
      while (canDescendObjectFootprint(world, gx, restY + 1, offsets)) {
        restY += 1;
      }
    }

    if (!removeFromActiveSlot()) return false;
    const objectId = allocateObjectId(world);

    // Some objects (torches, stones) placed in the air fall to the ground
    // with an animation instead of snapping into place.
    if (fallsWhenAirborne) {
      const fallingRestY = restY;
      if (fallingRestY > gy) {
        world.fallingObjects[objectId] = createDefaultFallingObjectState(objectId, materialId, gx, gy, fallingRestY, 0, offsets);
        return true;
      }
    }

    for (const [dx, dy] of offsets) {
      const x = gx + dx;
      const y = gy + dy;
      if (!grid.inBounds(x, y)) continue;
      placeWorldCell(world, x, y, materialId, { objectId });
      if (materialId === MaterialId.Faucet) grid.setFaucetFlow(x, y, 1);
    }
    return true;
  }

  // Brush-paint
  const r = state.brushSize;
  let placed = false;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = gx + dx;
      const y = gy + dy;
      if (!grid.inBounds(x, y)) continue;
      if (!withinPlacementRange(x, y)) continue;
      if (!canPlaceOver(grid, x, y, materialId)) continue;
      if (!removeFromActiveSlot()) return placed;
      placeWorldCell(world, x, y, materialId);
      placed = true;
    }
  }
  return placed;
}

/** Wires pointer events on `canvas` to paint or stamp the selected material into `grid`. */
export function attachInput(canvas: HTMLCanvasElement, world: WorldState, cellSize: number): void {
  const grid = world.grid;
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
          placeWorldCell(world, x, y, material);
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
    const materialId = state.selectedMaterial;
    const material = MATERIALS[materialId];
    if (material.placement.kind !== "object") return;
    const offsets = getObjectOffsets(materialId);
    if (!canPlaceObjectFootprint(world, materialId, gx, gy, offsets)) return;
    const objectId = allocateObjectId(world);
    for (const [dx, dy] of offsets) {
      const x = gx + dx;
      const y = gy + dy;
      placeWorldCell(world, x, y, materialId, { objectId });
      // Faucets start on low flow
      if (materialId === MaterialId.Faucet) {
        grid.setFaucetFlow(x, y, 1);
      }
    }
  };

  /** Flood-fill all connected faucet cells and cycle their flow state. */
  const cycleFaucet = (gx: number, gy: number): boolean => {
    if (state.toolMode === "play") {
      const objectId = world.grid.getObjectId(gx, gy);
      if (!objectId) return false;
      enqueuePlayCommand(world, {
        type: "cycle_faucet",
        x: gx,
        y: gy,
        objectId,
        expectedTargetRevision: world.grid.cellRevisions[world.grid.index(gx, gy)] ?? 0,
      });
      return true;
    }
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

  const start = (clientX: number, clientY: number) => {
    const pos = toGrid(clientX, clientY);
    // Clicking a faucet cycles its flow state
    if (cycleFaucet(pos.x, pos.y)) return;
    // Clicking a bloomed flower harvests it instead of painting
    if (handleHarvestInputAt(world, pos.x, pos.y)) {
      return;
    }
    if (state.toolMode === "play" && hasPickaxeEquipped()) {
      painting = false;
      lastGridPos = null;
      return;
    }
    // Place from hotbar material slot (works in play mode)
    if (state.toolMode === "play" && getActiveHotbarMaterial()) {
      placeHotbarMaterialAt(world, pos.x, pos.y);
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
