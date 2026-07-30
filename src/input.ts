import { Grid, MATERIALS, MaterialId, addToHotbar as addToHotbarHelper, allocateObjectId, createCommandEnvelope, createDefaultFallingObjectState, createDefaultPlayerState, enqueueCommand, findFlowerCluster, getNextActorSequence, harvestFlowerCluster, nextBool, placeWorldCell, removeFromHotbarSlot as removeFromHotbarSlotHelper, type GameplayCommand, type LocalTransportEditorCapability, type WorldState } from "@particle-sim/shared";
import { state, hasPickaxeEquipped, getActiveHotbarMaterial, getLocalPlayer } from "./state";

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

function getOrCreatePlayer(world: WorldState): NonNullable<WorldState["players"][string]> {
  let player = world.players[state.localPlayerId];
  if (!player) {
    player = createDefaultPlayerState(state.localPlayerId);
    world.players[state.localPlayerId] = player;
  }
  return player;
}

function mutateWorldWithEditor(editor: LocalTransportEditorCapability | undefined, world: WorldState, mutator: (targetWorld: WorldState) => void): void {
  if (state.toolMode === "editor" && editor) {
    editor.mutateWorld(mutator);
    return;
  }
  mutator(world);
}

function addToHotbarForWorld(world: WorldState, materialId: MaterialId, amount: number = 1): boolean {
  const player = getOrCreatePlayer(world);
  return addToHotbarHelper(player.hotbar, materialId, amount);
}

function removeActiveSlotForWorld(world: WorldState): boolean {
  const player = getOrCreatePlayer(world);
  const success = removeFromHotbarSlotHelper(player.hotbar, player.activeHotbarSlot);
  if (!success) return false;
  if (player.hotbar[player.activeHotbarSlot]?.kind === "empty") {
    for (let offset = 1; offset < player.hotbar.length; offset++) {
      const prev = player.activeHotbarSlot - offset;
      if (prev < 0) break;
      if (player.hotbar[prev].kind !== "empty") {
        player.activeHotbarSlot = prev;
        break;
      }
    }
  }
  return true;
}

function enqueuePlayCommand(world: WorldState, command: GameplayCommand): void {
  if (world === state.world) {
    state.transport.enqueueCommand(command);
    return;
  }
  const envelope = createCommandEnvelope(state.localPlayerId, getNextActorSequence(world, state.localPlayerId), world.tick, command);
  enqueueCommand(world, envelope);
}

function getPlayCommandComposition(world: WorldState): { projectedInventoryRevision: number; projectedCellRevision: (x: number, y: number) => number } {
  const transport = state.transport;
  const player = world.players[state.localPlayerId];
  if (transport) {
    const composition = transport.getCommandCompositionState(state.localPlayerId);
    return {
      projectedInventoryRevision: composition?.projectedInventoryRevision ?? player?.inventoryRevision ?? 0,
      projectedCellRevision: (x: number, y: number) => composition?.projectedCellRevision(x, y) ?? world.grid.cellRevisions[world.grid.index(x, y)] ?? 0,
    };
  }
  return {
    projectedInventoryRevision: player?.inventoryRevision ?? 0,
    projectedCellRevision: (x: number, y: number) => world.grid.cellRevisions[world.grid.index(x, y)] ?? 0,
  };
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

export function handleHarvestInputAt(world: WorldState, gx: number, gy: number, editor?: LocalTransportEditorCapability): boolean {
  if (state.toolMode === "play") {
    const cluster = findFlowerCluster(world.grid, gx, gy);
    if (!cluster || cluster.size === 0) {
      return false;
    }
    const composition = getPlayCommandComposition(world);
    const targetRevision = composition.projectedCellRevision(gx, gy);
    enqueuePlayCommand(world, { type: "harvest", x: gx, y: gy, expectedTargetRevision: targetRevision });
    return true;
  }

  let handled = false;
  mutateWorldWithEditor(editor, world, (targetWorld) => {
    const harvested = harvestFlowerCluster(targetWorld.grid, gx, gy);
    if (harvested <= 0) return;
    const player = getOrCreatePlayer(targetWorld);
    player.inventory.flowers += harvested;
    for (let index = 0; index < harvested; index++) {
      addToHotbarForWorld(targetWorld, MaterialId.Seed);
      if (nextBool(targetWorld.random, 0.1)) addToHotbarForWorld(targetWorld, MaterialId.Seed);
    }
    if (state.hoverPixel) {
      state.snip = { px: state.hoverPixel.x, py: state.hoverPixel.y, startTime: performance.now() };
    }
    handled = true;
  });
  return handled;
}

export function placeHotbarMaterialAt(world: WorldState, gx: number, gy: number, editor?: LocalTransportEditorCapability): boolean {
  if (state.toolMode === "play") {
    const composition = getPlayCommandComposition(world);
    enqueuePlayCommand(world, {
      type: "place",
      x: gx,
      y: gy,
      brushRadius: state.brushSize,
      expectedInventoryRevision: composition.projectedInventoryRevision,
      expectedAnchorRevision: composition.projectedCellRevision(gx, gy),
    });
    return true;
  }

  const hotbarMat = getActiveHotbarMaterial();
  if (!hotbarMat) return false;
  if (!withinPlacementRange(gx, gy)) return false;

  let placed = false;
  mutateWorldWithEditor(editor, world, (targetWorld) => {
    const materialId = hotbarMat.materialId;
    const matDef = MATERIALS[materialId];
    const grid = targetWorld.grid;

    if (matDef.placement.kind === "object") {
      const offsets = getObjectOffsets(materialId);
      if (offsets.length === 0) return;

      if (!canPlaceObjectFootprint(targetWorld, materialId, gx, gy, offsets)) {
        return;
      }

      let restY = gy;
      const fallsWhenAirborne = materialId === MaterialId.Torch || materialId === MaterialId.Stone;
      if (fallsWhenAirborne) {
        while (canDescendObjectFootprint(targetWorld, gx, restY + 1, offsets)) {
          restY += 1;
        }
      }

      if (!removeActiveSlotForWorld(targetWorld)) return;
      const objectId = allocateObjectId(targetWorld);

      if (fallsWhenAirborne) {
        const fallingRestY = restY;
        if (fallingRestY > gy) {
          targetWorld.fallingObjects[objectId] = createDefaultFallingObjectState(objectId, materialId, gx, gy, fallingRestY, 0, offsets);
          placed = true;
          return;
        }
      }

      for (const [dx, dy] of offsets) {
        const x = gx + dx;
        const y = gy + dy;
        if (!grid.inBounds(x, y)) continue;
        placeWorldCell(targetWorld, x, y, materialId, { objectId });
        if (materialId === MaterialId.Faucet) grid.setFaucetFlow(x, y, 1);
      }
      placed = true;
      return;
    }

    const r = state.brushSize;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (!grid.inBounds(x, y)) continue;
        if (!withinPlacementRange(x, y)) continue;
        if (!canPlaceOver(grid, x, y, materialId)) continue;
        if (!removeActiveSlotForWorld(targetWorld)) return;
        placeWorldCell(targetWorld, x, y, materialId);
        placed = true;
      }
    }
  });
  return placed;
}

/** Wires pointer events on `canvas` to paint or stamp the selected material into `grid`. */
export function attachInput(canvas: HTMLCanvasElement, cellSize: number, editor?: LocalTransportEditorCapability): void {
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
  const canPlaceOver = (grid: Grid, x: number, y: number, matId: MaterialId): boolean => {
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
    mutateWorldWithEditor(editor, state.world, (targetWorld) => {
      const grid = targetWorld.grid;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const x = gx + dx;
          const y = gy + dy;
          if (!grid.inBounds(x, y)) continue;
          if (!withinPlacementRange(x, y)) continue;
          if (canPlaceOver(grid, x, y, material)) {
            placeWorldCell(targetWorld, x, y, material);
          }
        }
      }
    });
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
    mutateWorldWithEditor(editor, state.world, (targetWorld) => {
      const grid = targetWorld.grid;
      const offsets = getObjectOffsets(materialId);
      if (!canPlaceObjectFootprint(targetWorld, materialId, gx, gy, offsets)) return;
      const objectId = allocateObjectId(targetWorld);
      for (const [dx, dy] of offsets) {
        const x = gx + dx;
        const y = gy + dy;
        placeWorldCell(targetWorld, x, y, materialId, { objectId });
        if (materialId === MaterialId.Faucet) {
          grid.setFaucetFlow(x, y, 1);
        }
      }
    });
  };

  /** Flood-fill all connected faucet cells and cycle their flow state. */
  const cycleFaucet = (gx: number, gy: number): boolean => {
    if (state.toolMode === "play") {
      const currentWorld = state.transport.getClientWorld();
      const objectId = currentWorld.grid.getObjectId(gx, gy);
      if (!objectId) return false;
      const composition = state.transport.getCommandCompositionState(state.localPlayerId);
      enqueuePlayCommand(state.world, {
        type: "cycle_faucet",
        x: gx,
        y: gy,
        objectId,
        expectedTargetRevision: composition?.projectedCellRevision(gx, gy) ?? currentWorld.grid.cellRevisions[currentWorld.grid.index(gx, gy)] ?? 0,
      });
      return true;
    }

    let handled = false;
    mutateWorldWithEditor(editor, state.world, (targetWorld) => {
      const grid = targetWorld.grid;
      if (grid.get(gx, gy) !== MaterialId.Faucet) return;
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
      handled = true;
    });
    return handled;
  };

  const start = (clientX: number, clientY: number) => {
    const pos = toGrid(clientX, clientY);
    // Clicking a faucet cycles its flow state
    if (cycleFaucet(pos.x, pos.y)) return;
    // Clicking a bloomed flower harvests it instead of painting
    if (handleHarvestInputAt(state.world, pos.x, pos.y, editor)) {
      return;
    }
    if (state.toolMode === "play" && hasPickaxeEquipped()) {
      painting = false;
      lastGridPos = null;
      return;
    }
    // Place from hotbar material slot (works in play mode)
    if (state.toolMode === "play" && getActiveHotbarMaterial()) {
      placeHotbarMaterialAt(state.world, pos.x, pos.y, editor);
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
