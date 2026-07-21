import { createCommandId, createPlayerId, parseCommandId, parseObjectId, parsePlayerId, type CommandId, type ObjectId, type PlayerId } from "./ids.js";
import { cloneHotbar, type HotbarItem, type InventoryCounts } from "./inventory.js";
import { Grid } from "./grid.js";
import { MATERIALS, MaterialId } from "./materials.js";
import { findFlowerCluster } from "./harvest.js";
import { hashVisualShade } from "./random.js";
import { allocateObjectId, type PersistedPlayerInputState, type PlayerState, type WorldState } from "./world-state.js";

export type GameplayCommandType =
  | "set_input_state"
  | "mine_start"
  | "mine_stop"
  | "select_slot"
  | "place"
  | "harvest"
  | "cycle_faucet"
  | "pause_world"
  | "resume_world";

export interface SetInputStateCommand {
  type: "set_input_state";
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  crouchHeld: boolean;
  lookUpHeld: boolean;
}

export interface MineCommand {
  type: "mine_start" | "mine_stop";
}

export interface SelectSlotCommand {
  type: "select_slot";
  slot: number;
  expectedInventoryRevision: number;
}

export interface PlaceCommand {
  type: "place";
  x: number;
  y: number;
  brushRadius: number;
  expectedInventoryRevision: number;
  expectedAnchorRevision: number;
}

export interface HarvestCommand {
  type: "harvest";
  x: number;
  y: number;
  expectedTargetRevision: number;
}

export interface CycleFaucetCommand {
  type: "cycle_faucet";
  x: number;
  y: number;
  objectId: ObjectId;
  expectedTargetRevision: number;
}

export interface PauseWorldCommand {
  type: "pause_world";
  expectedWorldRevision: number;
}

export interface ResumeWorldCommand {
  type: "resume_world";
  expectedWorldRevision: number;
}

export type GameplayCommand =
  | SetInputStateCommand
  | MineCommand
  | SelectSlotCommand
  | PlaceCommand
  | HarvestCommand
  | CycleFaucetCommand
  | PauseWorldCommand
  | ResumeWorldCommand;

export interface CommandEnvelope {
  commandId: CommandId;
  actorId: PlayerId;
  actorSequence: number;
  issuedTick: number;
  command: GameplayCommand;
}

export type CommandResultCode =
  | "accepted"
  | "unknown_actor"
  | "paused"
  | "not_owner"
  | "already_state"
  | "future_tick"
  | "stale"
  | "conflict"
  | "slot"
  | "tool"
  | "revision"
  | "inventory"
  | "target"
  | "bounds"
  | "range"
  | "collision"
  | "footprint"
  | "work_limit"
  | "invalid_command";

export interface CommandReceipt {
  commandId: CommandId;
  actorId: PlayerId;
  actorSequence: number;
  authorityOrder: number | null;
  issuedTick: number;
  processedTick: number;
  commandType: GameplayCommandType;
  code: CommandResultCode;
  accepted: boolean;
  beforeWorldRevision: number;
  afterWorldRevision: number;
  beforeInventoryRevision: number;
  afterInventoryRevision: number;
  beforeTargetRevision: number;
  afterTargetRevision: number;
  acceptedEffect: string | null;
  fingerprint: string;
}

export interface CommandResult {
  kind: "accepted" | "rejected";
  code: CommandResultCode;
  command: GameplayCommand;
  actor: PlayerId;
  actorSequence: number;
  type: GameplayCommandType;
  authorityOrder: number | null;
  issuedTick: number;
  processedTick: number;
  beforeWorldRevision: number;
  afterWorldRevision: number;
  beforeInventoryRevision: number;
  afterInventoryRevision: number;
  beforeTargetRevision: number;
  afterTargetRevision: number;
  acceptedEffect: string | null;
}

export interface CommandGridWrite {
  x: number;
  y: number;
  id: MaterialId;
  shade: number;
  auxiliary: number;
  objectId: ObjectId | null;
}

export interface CommandFallingObjectCreate {
  id: ObjectId;
  materialId: MaterialId;
  x: number;
  y: number;
  restY: number;
  vy: number;
  offsets: [number, number][];
  provenance: {
    kind: "placement";
    actorId: PlayerId;
    commandId: CommandId;
    sourceSlot: number;
    materialId: MaterialId;
    amount: 1;
  };
}

export interface CommandPlayerPatch {
  id: PlayerId;
  input?: PersistedPlayerInputState;
  activeHotbarSlot?: number;
  inventory?: InventoryCounts;
  hotbar?: HotbarItem[];
  inventoryRevision?: number;
  pendingRefunds?: Record<string, number>;
}

export interface ValidatedCommandPlan {
  kind: "plan";
  envelope: CommandEnvelope;
  accepted: boolean;
  resultCode: CommandResultCode;
  authorityOrder: number | null;
  beforeWorldRevision: number;
  afterWorldRevision: number;
  beforeInventoryRevision: number;
  afterInventoryRevision: number;
  beforeTargetRevision: number;
  afterTargetRevision: number;
  acceptedEffect: string | null;
  playerPatch?: CommandPlayerPatch;
  gridWrites: CommandGridWrite[];
  fallingObjects: CommandFallingObjectCreate[];
  paused?: boolean;
  worldRevisionDelta: number;
  inventoryRevisionDelta: number;
  targetRevisionDelta: number;
}

export interface CommandRejection {
  kind: "rejection";
  envelope: CommandEnvelope;
  code: CommandResultCode;
  admitted: boolean;
  authorityOrder: number | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function cloneInventoryCounts(inventory: InventoryCounts): InventoryCounts {
  const normalized: InventoryCounts = { flowers: inventory.flowers };
  for (const [key, amount] of Object.entries(inventory)) {
    if (key === "flowers") continue;
    normalized[key] = amount;
  }
  return normalized;
}

function clonePersistedInput(input: PersistedPlayerInputState): PersistedPlayerInputState {
  return {
    left: input.left,
    right: input.right,
    jumpHeld: input.jumpHeld,
    crouchHeld: input.crouchHeld,
    lookUpHeld: input.lookUpHeld,
    mineHeld: input.mineHeld,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeCommandFingerprint(envelope: CommandEnvelope): string {
  return stableStringify({
    commandId: envelope.commandId,
    actorId: envelope.actorId,
    actorSequence: envelope.actorSequence,
    issuedTick: envelope.issuedTick,
    command: envelope.command,
  });
}

function createRejection(envelope: CommandEnvelope, code: CommandResultCode, admitted = false, authorityOrder: number | null = null): CommandRejection {
  return { kind: "rejection", envelope, code, admitted, authorityOrder };
}

export function getNextActorSequence(world: WorldState, actorId: PlayerId): number {
  const pendingSequences = (world.commandInbox ?? [])
    .filter((entry): entry is CommandEnvelope => typeof entry === "object" && entry !== null && "actorId" in entry && "actorSequence" in entry)
    .filter((entry) => entry.actorId === actorId)
    .map((entry) => entry.actorSequence);
  const highWater = world.commandLedger.actorHighWater[actorId] ?? 0;
  return Math.max(highWater, ...pendingSequences, 0) + 1;
}

function createCommandResult(planOrRejection: ValidatedCommandPlan | CommandRejection, world: WorldState): CommandResult {
  if (planOrRejection.kind === "plan") {
    return {
      kind: "accepted",
      code: planOrRejection.resultCode,
      command: planOrRejection.envelope.command,
      actor: planOrRejection.envelope.actorId,
      actorSequence: planOrRejection.envelope.actorSequence,
      type: planOrRejection.envelope.command.type,
      authorityOrder: planOrRejection.authorityOrder,
      issuedTick: planOrRejection.envelope.issuedTick,
      processedTick: world.tick,
      beforeWorldRevision: planOrRejection.beforeWorldRevision,
      afterWorldRevision: planOrRejection.afterWorldRevision,
      beforeInventoryRevision: planOrRejection.beforeInventoryRevision,
      afterInventoryRevision: planOrRejection.afterInventoryRevision,
      beforeTargetRevision: planOrRejection.beforeTargetRevision,
      afterTargetRevision: planOrRejection.afterTargetRevision,
      acceptedEffect: planOrRejection.acceptedEffect,
    };
  }
  const actor = world.players[planOrRejection.envelope.actorId];
  return {
    kind: "rejected",
    code: planOrRejection.code,
    command: planOrRejection.envelope.command,
    actor: planOrRejection.envelope.actorId,
    actorSequence: planOrRejection.envelope.actorSequence,
    type: planOrRejection.envelope.command.type,
    authorityOrder: planOrRejection.authorityOrder,
    issuedTick: planOrRejection.envelope.issuedTick,
    processedTick: world.tick,
    beforeWorldRevision: world.worldRevision,
    afterWorldRevision: world.worldRevision,
    beforeInventoryRevision: actor?.inventoryRevision ?? 0,
    afterInventoryRevision: actor?.inventoryRevision ?? 0,
    beforeTargetRevision: world.worldRevision,
    afterTargetRevision: world.worldRevision,
    acceptedEffect: null,
  };
}

function getCommandFingerprint(envelope: CommandEnvelope): string {
  return sanitizeCommandFingerprint(envelope);
}

function createResultFromReceipt(receipt: CommandReceipt, envelope: CommandEnvelope): CommandResult {
  return {
    kind: receipt.accepted ? "accepted" : "rejected",
    code: receipt.code,
    command: envelope.command,
    actor: receipt.actorId,
    actorSequence: receipt.actorSequence,
    type: receipt.commandType,
    authorityOrder: receipt.authorityOrder,
    issuedTick: receipt.issuedTick,
    processedTick: receipt.processedTick,
    beforeWorldRevision: receipt.beforeWorldRevision,
    afterWorldRevision: receipt.afterWorldRevision,
    beforeInventoryRevision: receipt.beforeInventoryRevision,
    afterInventoryRevision: receipt.afterInventoryRevision,
    beforeTargetRevision: receipt.beforeTargetRevision,
    afterTargetRevision: receipt.afterTargetRevision,
    acceptedEffect: receipt.acceptedEffect,
  };
}

function findDuplicateReceipt(world: WorldState, envelope: CommandEnvelope): CommandReceipt | undefined {
  return world.commandLedger.recent.find((receipt) => receipt.actorId === envelope.actorId && receipt.actorSequence === envelope.actorSequence && receipt.commandId === envelope.commandId && receipt.fingerprint === getCommandFingerprint(envelope));
}

function findConflictingReceipt(world: WorldState, envelope: CommandEnvelope): CommandReceipt | undefined {
  return world.commandLedger.recent.find((receipt) => {
    if (receipt.actorId !== envelope.actorId || receipt.actorSequence !== envelope.actorSequence) return false;
    if (receipt.commandId !== envelope.commandId) return true;
    return receipt.fingerprint !== getCommandFingerprint(envelope);
  });
}

function recordReceipt(world: WorldState, envelope: CommandEnvelope, result: CommandResult, authorityOrder: number | null): void {
  const receipt: CommandReceipt = {
    commandId: envelope.commandId,
    actorId: envelope.actorId,
    actorSequence: envelope.actorSequence,
    authorityOrder,
    issuedTick: envelope.issuedTick,
    processedTick: world.tick,
    commandType: envelope.command.type,
    code: result.code,
    accepted: result.kind === "accepted",
    beforeWorldRevision: result.beforeWorldRevision,
    afterWorldRevision: result.afterWorldRevision,
    beforeInventoryRevision: result.beforeInventoryRevision,
    afterInventoryRevision: result.afterInventoryRevision,
    beforeTargetRevision: result.beforeTargetRevision,
    afterTargetRevision: result.afterTargetRevision,
    acceptedEffect: result.acceptedEffect,
    fingerprint: getCommandFingerprint(envelope),
  };
  world.commandLedger.recent.push(receipt);
  if (world.commandLedger.recent.length > 256) {
    world.commandLedger.recent.splice(0, world.commandLedger.recent.length - 256);
  }
}

function assertAllowedFields(value: Record<string, unknown>, allowedFields: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new TypeError(`${label} contains unknown field ${key}`);
    }
  }
}

function parseGameplayCommand(value: unknown): GameplayCommand | null {
  if (!isPlainObject(value)) return null;
  try {
    const type = value["type"];
    if (typeof type !== "string") return null;
    switch (type) {
      case "set_input_state": {
        assertAllowedFields(value, new Set(["type", "left", "right", "jumpHeld", "crouchHeld", "lookUpHeld"]), "set_input_state");
        return {
          type,
          left: assertBoolean(value["left"], "left"),
          right: assertBoolean(value["right"], "right"),
          jumpHeld: assertBoolean(value["jumpHeld"], "jumpHeld"),
          crouchHeld: assertBoolean(value["crouchHeld"], "crouchHeld"),
          lookUpHeld: assertBoolean(value["lookUpHeld"], "lookUpHeld"),
        };
      }
      case "mine_start":
      case "mine_stop": {
        assertAllowedFields(value, new Set(["type"]), type);
        return { type };
      }
      case "select_slot": {
        assertAllowedFields(value, new Set(["type", "slot", "expectedInventoryRevision"]), "select_slot");
        return {
          type,
          slot: assertSafeInteger(value["slot"], "slot"),
          expectedInventoryRevision: assertSafeInteger(value["expectedInventoryRevision"], "expectedInventoryRevision"),
        };
      }
      case "place": {
        assertAllowedFields(value, new Set(["type", "x", "y", "brushRadius", "expectedInventoryRevision", "expectedAnchorRevision"]), "place");
        return {
          type,
          x: assertSafeInteger(value["x"], "x"),
          y: assertSafeInteger(value["y"], "y"),
          brushRadius: assertSafeInteger(value["brushRadius"], "brushRadius"),
          expectedInventoryRevision: assertSafeInteger(value["expectedInventoryRevision"], "expectedInventoryRevision"),
          expectedAnchorRevision: assertSafeInteger(value["expectedAnchorRevision"], "expectedAnchorRevision"),
        };
      }
      case "harvest": {
        assertAllowedFields(value, new Set(["type", "x", "y", "expectedTargetRevision"]), "harvest");
        return {
          type,
          x: assertSafeInteger(value["x"], "x"),
          y: assertSafeInteger(value["y"], "y"),
          expectedTargetRevision: assertSafeInteger(value["expectedTargetRevision"], "expectedTargetRevision"),
        };
      }
      case "cycle_faucet": {
        assertAllowedFields(value, new Set(["type", "x", "y", "objectId", "expectedTargetRevision"]), "cycle_faucet");
        return {
          type,
          x: assertSafeInteger(value["x"], "x"),
          y: assertSafeInteger(value["y"], "y"),
          objectId: parseObjectId(value["objectId"]),
          expectedTargetRevision: assertSafeInteger(value["expectedTargetRevision"], "expectedTargetRevision"),
        };
      }
      case "pause_world":
      case "resume_world": {
        assertAllowedFields(value, new Set(["type", "expectedWorldRevision"]), type);
        return {
          type,
          expectedWorldRevision: assertSafeInteger(value["expectedWorldRevision"], "expectedWorldRevision"),
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseEnvelope(value: unknown): CommandEnvelope | null {
  if (!isPlainObject(value)) return null;
  try {
    assertAllowedFields(value, new Set(["commandId", "actorId", "actorSequence", "issuedTick", "command"]), "command envelope");
    const commandId = parseCommandId(value["commandId"]);
    const actorId = parsePlayerId(value["actorId"]);
    const actorSequence = assertSafeInteger(value["actorSequence"], "actorSequence");
    const issuedTick = assertSafeInteger(value["issuedTick"], "issuedTick");
    if (actorSequence < 0 || issuedTick < 0) throw new TypeError("negative sequence/tick");
    const command = parseGameplayCommand(value["command"]);
    if (!command) return null;
    return { commandId, actorId, actorSequence, issuedTick, command };
  } catch {
    return null;
  }
}

function getTargetRevision(grid: Grid, x: number, y: number): number {
  const index = grid.index(x, y);
  return grid.cellRevisions[index] ?? 0;
}

function collectHarvestPlan(grid: Grid, startX: number, startY: number): { cells: Array<[number, number]>; bloomCount: number } | null {
  const cluster = findFlowerCluster(grid, startX, startY);
  if (!cluster || cluster.size === 0) return null;

  const cells = Array.from(cluster, (idx) => {
    const x = idx % grid.width;
    const y = Math.floor(idx / grid.width);
    return [x, y] as [number, number];
  });

  const flowerIndices = new Set<number>();
  for (const idx of cluster) {
    if ((grid.ids[idx] as MaterialId) === MaterialId.Flower) {
      flowerIndices.add(idx);
    }
  }

  if (flowerIndices.size === 0) {
    return { cells, bloomCount: 0 };
  }

  let bloomCount = 0;
  const visited = new Set<number>();
  for (const idx of flowerIndices) {
    if (visited.has(idx)) continue;
    bloomCount += 1;
    const colorVariant = grid.getFlowerPalette(idx % grid.width, Math.floor(idx / grid.width));
    const queue = [idx];
    visited.add(idx);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const cx = current % grid.width;
      const cy = (current - cx) / grid.width;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        const nextIndex = ny * grid.width + nx;
        if (!flowerIndices.has(nextIndex) || visited.has(nextIndex)) continue;
        const nextColorVariant = grid.getFlowerPalette(nx, ny);
        if (nextColorVariant !== colorVariant) continue;
        visited.add(nextIndex);
        queue.push(nextIndex);
      }
    }
  }

  return { cells, bloomCount };
}

function withinPlacementRange(actor: PlayerState, gx: number, gy: number): boolean {
  const cx = actor.x + actor.width / 2;
  const cy = actor.y + actor.height / 2;
  const dx = gx - cx;
  const dy = gy - cy;
  return dx * dx + dy * dy <= 30 * 30;
}

function canPlaceOver(grid: Grid, x: number, y: number, materialId: MaterialId): boolean {
  const existing = grid.get(x, y);
  if (existing === MaterialId.Empty) return true;
  if (materialId === MaterialId.Empty) return true;
  if (existing === MaterialId.Water && !MATERIALS[materialId].permeable) return true;
  return false;
}

function getObjectOffsets(materialId: MaterialId): [number, number][] {
  const material = MATERIALS[materialId];
  if (material.placement.kind !== "object") return [];
  const { shape, width, height } = material.placement;
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

function canPlaceObjectFootprint(world: WorldState, actor: PlayerState, materialId: MaterialId, anchorX: number, anchorY: number, offsets: [number, number][]): boolean {
  const grid = world.grid;
  for (const [dx, dy] of offsets) {
    const x = anchorX + dx;
    const y = anchorY + dy;
    if (!grid.inBounds(x, y)) return false;
    if (!withinPlacementRange(actor, x, y)) return false;
    if (!canPlaceOver(grid, x, y, materialId)) return false;
  }
  return true;
}

function canDescendObjectFootprint(world: WorldState, anchorX: number, anchorY: number, offsets: [number, number][]): boolean {
  const grid = world.grid;
  for (const [dx, dy] of offsets) {
    const x = anchorX + dx;
    const y = anchorY + dy;
    if (!grid.inBounds(x, y)) return false;
    if (grid.get(x, y) !== MaterialId.Empty) return false;
  }
  return true;
}

function buildPlacementPlan(world: WorldState, actor: PlayerState, commandId: CommandId, command: PlaceCommand, materialId: MaterialId): { gridWrites: CommandGridWrite[]; fallingObjects: CommandFallingObjectCreate[]; playerPatch?: CommandPlayerPatch; inventoryRevisionDelta: number; worldRevisionDelta: number; acceptedEffect: string | null; resultCode: CommandResultCode } {
  const slot = actor.activeHotbarSlot;
  const hotbarEntry = actor.hotbar[slot];
  if (hotbarEntry?.kind !== "material") {
    return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "tool" };
  }
  if (command.brushRadius < 1 || command.brushRadius > 16) {
    return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "range" };
  }
  if (command.expectedInventoryRevision !== actor.inventoryRevision) {
    return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "revision" };
  }
  const anchorIndex = world.grid.index(command.x, command.y);
  if (command.expectedAnchorRevision !== (world.grid.cellRevisions[anchorIndex] ?? 0)) {
    return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "revision" };
  }

  const placementCount = Math.min(hotbarEntry.count, 1);
  if (placementCount <= 0) {
    return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "inventory" };
  }

  const material = MATERIALS[materialId];
  if (material.placement.kind === "object") {
    const offsets = getObjectOffsets(materialId);
    if (offsets.length === 0) {
      return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "bounds" };
    }
    if (!canPlaceObjectFootprint(world, actor, materialId, command.x, command.y, offsets)) {
      return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "footprint" };
    }
    const objectId = allocateObjectId(world);
    const fallsWhenAirborne = materialId === MaterialId.Torch || materialId === MaterialId.Stone;
    let restY = command.y;
    if (fallsWhenAirborne) {
      while (canDescendObjectFootprint(world, command.x, restY + 1, offsets)) {
        restY += 1;
      }
    }
    const gridWrites: CommandGridWrite[] = [];
    if (!fallsWhenAirborne || restY <= command.y) {
      for (const [dx, dy] of offsets) {
        const x = command.x + dx;
        const y = command.y + dy;
        if (!world.grid.inBounds(x, y)) continue;
        gridWrites.push({ x, y, id: materialId, shade: hashVisualShade(world.random.seed, x, y, materialId), auxiliary: 0, objectId });
      }
    }
    const fallingObjects: CommandFallingObjectCreate[] = [];
    if (fallsWhenAirborne && restY > command.y) {
      fallingObjects.push({
        id: objectId,
        materialId,
        x: command.x,
        y: command.y,
        restY,
        vy: 0,
        offsets,
        provenance: { kind: "placement", actorId: actor.id, commandId, sourceSlot: slot, materialId, amount: 1 },
      });
    }
    const nextHotbar = cloneHotbar(actor.hotbar);
    nextHotbar[slot] = { kind: "material", materialId: hotbarEntry.materialId, count: hotbarEntry.count - 1 };
    const playerPatch: CommandPlayerPatch = {
      id: actor.id,
      hotbar: nextHotbar,
      inventoryRevision: actor.inventoryRevision + 1,
    };
    return { gridWrites, fallingObjects, playerPatch, inventoryRevisionDelta: 1, worldRevisionDelta: 1, acceptedEffect: "inventory", resultCode: "accepted" };
  }

  const candidates: Array<[number, number]> = [];
  for (let dy = -command.brushRadius; dy <= command.brushRadius; dy += 1) {
    for (let dx = -command.brushRadius; dx <= command.brushRadius; dx += 1) {
      if (dx * dx + dy * dy > command.brushRadius * command.brushRadius) continue;
      const px = command.x + dx;
      const py = command.y + dy;
      if (!world.grid.inBounds(px, py)) continue;
      if (!canPlaceOver(world.grid, px, py, materialId)) continue;
      candidates.push([px, py]);
    }
  }
  if (candidates.length === 0) {
    return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "bounds" };
  }
  const actualPlacementCount = Math.min(hotbarEntry.count, candidates.length);
  const gridWrites = candidates.slice(0, actualPlacementCount).map(([x, y]) => ({ x, y, id: materialId, shade: hashVisualShade(world.random.seed, x, y, materialId), auxiliary: 0, objectId: null }));
  if (gridWrites.length === 0) {
    return { gridWrites: [], fallingObjects: [], inventoryRevisionDelta: 0, worldRevisionDelta: 0, acceptedEffect: null, resultCode: "inventory" };
  }
  const nextHotbar = cloneHotbar(actor.hotbar);
  nextHotbar[slot] = { kind: "material", materialId: hotbarEntry.materialId, count: hotbarEntry.count - gridWrites.length };
  const playerPatch: CommandPlayerPatch = {
    id: actor.id,
    hotbar: nextHotbar,
    inventoryRevision: actor.inventoryRevision + 1,
  };
  return { gridWrites, fallingObjects: [], playerPatch, inventoryRevisionDelta: 1, worldRevisionDelta: 1, acceptedEffect: "inventory", resultCode: "accepted" };
}

function createPlan(envelope: CommandEnvelope, resultCode: CommandResultCode, accepted: boolean, beforeWorldRevision: number, afterWorldRevision: number, beforeInventoryRevision: number, afterInventoryRevision: number, beforeTargetRevision: number, afterTargetRevision: number, acceptedEffect: string | null, playerPatch?: CommandPlayerPatch, gridWrites: CommandGridWrite[] = [], fallingObjects: CommandFallingObjectCreate[] = [], paused?: boolean, worldRevisionDelta = 0, inventoryRevisionDelta = 0, targetRevisionDelta = 0): ValidatedCommandPlan {
  return {
    kind: "plan",
    envelope,
    accepted,
    resultCode,
    authorityOrder: null,
    beforeWorldRevision,
    afterWorldRevision,
    beforeInventoryRevision,
    afterInventoryRevision,
    beforeTargetRevision,
    afterTargetRevision,
    acceptedEffect,
    playerPatch,
    gridWrites,
    fallingObjects,
    paused,
    worldRevisionDelta,
    inventoryRevisionDelta,
    targetRevisionDelta,
  };
}

function clonePlayerStateForPatch(player: PlayerState): CommandPlayerPatch {
  return {
    id: player.id,
    input: clonePersistedInput(player.input),
    activeHotbarSlot: player.activeHotbarSlot,
    inventory: cloneInventoryCounts(player.inventory),
    hotbar: cloneHotbar(player.hotbar),
    inventoryRevision: player.inventoryRevision,
    pendingRefunds: { ...(player.pendingRefunds ?? {}) },
  };
}

export function validateCommand(world: WorldState, envelopeInput: unknown): ValidatedCommandPlan | CommandRejection {
  const envelope = parseEnvelope(envelopeInput);
  if (!envelope) {
    return createRejection({ commandId: createCommandId("command_invalid"), actorId: createPlayerId("player_invalid"), actorSequence: 0, issuedTick: 0, command: { type: "set_input_state", left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false } }, "invalid_command", false);
  }

  const ledger = world.commandLedger;
  const actorHighWater = ledger.actorHighWater[envelope.actorId] ?? 0;
  const fingerprint = getCommandFingerprint(envelope);
  const existingReceipt = ledger.recent.find((receipt) => receipt.actorId === envelope.actorId && receipt.actorSequence === envelope.actorSequence && receipt.commandId === envelope.commandId && receipt.fingerprint === fingerprint);
  if (existingReceipt) {
    return createRejection(envelope, "accepted", false);
  }
  const conflictingReceipt = ledger.recent.find((receipt) => receipt.actorId === envelope.actorId && receipt.actorSequence === envelope.actorSequence && receipt.commandId !== envelope.commandId);
  if (conflictingReceipt) {
    return createRejection(envelope, "conflict", false);
  }
  if (envelope.actorSequence > actorHighWater + 1) {
    return createRejection(envelope, "future_tick", false);
  }
  if (envelope.actorSequence <= actorHighWater) {
    return createRejection(envelope, "stale", false);
  }
  if (envelope.issuedTick > world.tick + 1) {
    return createRejection(envelope, "future_tick", false);
  }

  const actor = world.players[envelope.actorId];
  if (!actor) {
    return createRejection(envelope, "unknown_actor", false);
  }

  if (world.paused && envelope.command.type !== "pause_world" && envelope.command.type !== "resume_world") {
    return createRejection(envelope, "paused", true);
  }

  const beforeWorldRevision = world.worldRevision;
  const beforeInventoryRevision = actor.inventoryRevision;
  const beforeTargetRevision = world.worldRevision;
  let playerPatch: CommandPlayerPatch | undefined;
  let gridWrites: CommandGridWrite[] = [];
  let fallingObjects: CommandFallingObjectCreate[] = [];
  let paused: boolean | undefined;
  let worldRevisionDelta = 0;
  let inventoryRevisionDelta = 0;
  let targetRevisionDelta = 0;
  let acceptedEffect: string | null = null;
  let resultCode: CommandResultCode = "accepted";

  switch (envelope.command.type) {
    case "set_input_state": {
      playerPatch = clonePlayerStateForPatch(actor);
      playerPatch.input = {
        ...playerPatch.input!,
        left: envelope.command.left,
        right: envelope.command.right,
        jumpHeld: envelope.command.jumpHeld,
        crouchHeld: envelope.command.crouchHeld,
        lookUpHeld: envelope.command.lookUpHeld,
      };
      acceptedEffect = "input";
      break;
    }
    case "mine_start": {
      playerPatch = clonePlayerStateForPatch(actor);
      playerPatch.input = { ...playerPatch.input!, mineHeld: true };
      acceptedEffect = "input";
      break;
    }
    case "mine_stop": {
      playerPatch = clonePlayerStateForPatch(actor);
      playerPatch.input = { ...playerPatch.input!, mineHeld: false };
      acceptedEffect = "input";
      break;
    }
    case "select_slot": {
      if (envelope.command.slot < 0 || envelope.command.slot > 9) {
        resultCode = "slot";
        break;
      }
      if (envelope.command.expectedInventoryRevision !== actor.inventoryRevision) {
        resultCode = "revision";
        break;
      }
      playerPatch = clonePlayerStateForPatch(actor);
      playerPatch.activeHotbarSlot = envelope.command.slot;
      acceptedEffect = "hotbar";
      break;
    }
    case "place": {
      const hotbarItem = actor.hotbar[actor.activeHotbarSlot];
      const materialId = hotbarItem?.kind === "material"
        ? hotbarItem.materialId
        : null;
      if (!materialId) {
        resultCode = "tool";
        break;
      }
      const placementResult = buildPlacementPlan(world, actor, envelope.commandId, envelope.command, materialId);
      if (placementResult.resultCode !== "accepted") {
        resultCode = placementResult.resultCode;
        break;
      }
      playerPatch = placementResult.playerPatch;
      gridWrites = placementResult.gridWrites;
      fallingObjects = placementResult.fallingObjects;
      acceptedEffect = placementResult.acceptedEffect;
      inventoryRevisionDelta = placementResult.inventoryRevisionDelta;
      worldRevisionDelta = placementResult.worldRevisionDelta;
      break;
    }
    case "harvest": {
      const index = world.grid.index(envelope.command.x, envelope.command.y);
      if (envelope.command.expectedTargetRevision !== (world.grid.cellRevisions[index] ?? 0)) {
        resultCode = "revision";
        break;
      }
      const harvestPlan = collectHarvestPlan(world.grid, envelope.command.x, envelope.command.y);
      if (!harvestPlan || harvestPlan.cells.length === 0) {
        resultCode = "target";
        break;
      }
      playerPatch = clonePlayerStateForPatch(actor);
      playerPatch.inventory = cloneInventoryCounts(actor.inventory);
      playerPatch.inventory.flowers = (playerPatch.inventory.flowers ?? 0) + harvestPlan.bloomCount;
      playerPatch.inventoryRevision = actor.inventoryRevision + 1;
      gridWrites = harvestPlan.cells.map(([x, y]) => ({ x, y, id: MaterialId.Empty, shade: 0, auxiliary: 0, objectId: null }));
      acceptedEffect = "inventory";
      inventoryRevisionDelta = 1;
      worldRevisionDelta = 1;
      break;
    }
    case "cycle_faucet": {
      const cell = world.grid.get(envelope.command.x, envelope.command.y);
      if (cell !== MaterialId.Faucet) {
        resultCode = "target";
        break;
      }
      const faucetObjectId = world.grid.getObjectId(envelope.command.x, envelope.command.y);
      if (envelope.command.objectId !== faucetObjectId) {
        resultCode = "target";
        break;
      }
      const revision = getTargetRevision(world.grid, envelope.command.x, envelope.command.y);
      if (envelope.command.expectedTargetRevision !== revision) {
        resultCode = "revision";
        break;
      }
      const nextAux = (world.grid.getAuxiliaryValue(envelope.command.x, envelope.command.y) + 1) % 3;
      gridWrites = [];
      for (let y = 0; y < world.grid.height; y++) {
        for (let x = 0; x < world.grid.width; x++) {
          if (world.grid.getObjectId(x, y) !== faucetObjectId) continue;
          gridWrites.push({
            x,
            y,
            id: MaterialId.Faucet,
            shade: world.grid.shade[world.grid.index(x, y)] ?? 0,
            auxiliary: nextAux,
            objectId: faucetObjectId
          });
        }
      }
      acceptedEffect = "target";
      worldRevisionDelta = 1;
      break;
    }
    case "pause_world": {
      if (world.ownerPlayerId !== null && world.ownerPlayerId !== envelope.actorId) {
        resultCode = "not_owner";
        break;
      }
      if (world.paused) {
        resultCode = "already_state";
        break;
      }
      if (envelope.command.expectedWorldRevision !== world.worldRevision) {
        resultCode = "revision";
        break;
      }
      paused = true;
      acceptedEffect = "pause";
      worldRevisionDelta = 1;
      break;
    }
    case "resume_world": {
      if (world.ownerPlayerId !== null && world.ownerPlayerId !== envelope.actorId) {
        resultCode = "not_owner";
        break;
      }
      if (!world.paused) {
        resultCode = "already_state";
        break;
      }
      if (envelope.command.expectedWorldRevision !== world.worldRevision) {
        resultCode = "revision";
        break;
      }
      paused = false;
      acceptedEffect = "resume";
      worldRevisionDelta = 1;
      break;
    }
    default:
      resultCode = "invalid_command";
      break;
  }

  if (resultCode !== "accepted") {
    return createRejection(envelope, resultCode, true);
  }

  return createPlan(
    envelope,
    resultCode,
    true,
    beforeWorldRevision,
    beforeWorldRevision + worldRevisionDelta,
    beforeInventoryRevision,
    beforeInventoryRevision + inventoryRevisionDelta,
    beforeTargetRevision,
    beforeTargetRevision + targetRevisionDelta,
    acceptedEffect,
    playerPatch,
    gridWrites,
    fallingObjects,
    paused,
    worldRevisionDelta,
    inventoryRevisionDelta,
    targetRevisionDelta,
  );
}

export function commitValidatedPlan(world: WorldState, plan: ValidatedCommandPlan): void {
  if (plan.playerPatch) {
    const player = world.players[plan.playerPatch.id];
    if (player) {
      if (plan.playerPatch.input) player.input = plan.playerPatch.input;
      if (plan.playerPatch.activeHotbarSlot !== undefined) player.activeHotbarSlot = plan.playerPatch.activeHotbarSlot;
      if (plan.playerPatch.inventory) player.inventory = plan.playerPatch.inventory;
      if (plan.playerPatch.hotbar) player.hotbar = plan.playerPatch.hotbar;
      if (plan.playerPatch.inventoryRevision !== undefined) player.inventoryRevision = plan.playerPatch.inventoryRevision;
      if (plan.playerPatch.pendingRefunds) player.pendingRefunds = plan.playerPatch.pendingRefunds;
    }
  }
  for (const write of plan.gridWrites) {
    world.grid.set(write.x, write.y, write.id, { shade: write.shade, objectId: write.objectId });
    if (write.id === MaterialId.Faucet && write.auxiliary !== 0) {
      world.grid.setAuxiliaryValue(write.x, write.y, write.auxiliary);
    }
  }
  for (const fallingObject of plan.fallingObjects) {
    world.fallingObjects[fallingObject.id] = {
      id: fallingObject.id,
      materialId: fallingObject.materialId,
      x: fallingObject.x,
      y: fallingObject.y,
      restY: fallingObject.restY,
      vy: fallingObject.vy,
      offsets: fallingObject.offsets.map(([dx, dy]) => [dx, dy] as [number, number]),
      provenance: fallingObject.provenance,
    };
  }
  if (plan.paused !== undefined) {
    world.paused = plan.paused;
  }
  world.worldRevision += plan.worldRevisionDelta;
}

export function processCommand(world: WorldState, envelopeInput: unknown): CommandResult {
  const envelope = parseEnvelope(envelopeInput);
  if (!envelope) {
    const rejection = createRejection({ commandId: createCommandId("command_invalid"), actorId: createPlayerId("player_invalid"), actorSequence: 0, issuedTick: 0, command: { type: "set_input_state", left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false } }, "invalid_command", false);
    const result = createCommandResult(rejection, world);
    recordReceipt(world, rejection.envelope, result, null);
    return result;
  }

  const duplicateReceipt = findDuplicateReceipt(world, envelope);
  if (duplicateReceipt) {
    return createResultFromReceipt(duplicateReceipt, envelope);
  }

  const conflictingReceipt = findConflictingReceipt(world, envelope);
  if (conflictingReceipt) {
    const rejection = createRejection(envelope, "conflict", false);
    const result = createCommandResult(rejection, world);
    recordReceipt(world, envelope, result, null);
    return result;
  }

  const validation = validateCommand(world, envelope);
  if (validation.kind === "rejection") {
    const authorityOrder = validation.admitted ? world.nextAuthorityOrder : null;
    if (authorityOrder !== null) {
      validation.authorityOrder = authorityOrder;
      world.nextAuthorityOrder = authorityOrder + 1;
      world.commandLedger.actorHighWater[envelope.actorId] = envelope.actorSequence;
    }
    const result = createCommandResult(validation, world);
    recordReceipt(world, envelope, result, authorityOrder);
    return result;
  }

  const authorityOrder = world.nextAuthorityOrder;
  validation.authorityOrder = authorityOrder;
  world.nextAuthorityOrder = authorityOrder + 1;
  world.commandLedger.actorHighWater[envelope.actorId] = envelope.actorSequence;
  const result = createCommandResult(validation, world);
  commitValidatedPlan(world, validation);
  recordReceipt(world, validation.envelope, result, authorityOrder);
  return result;
}

export function processPendingCommands(world: WorldState, inbox: Array<unknown> = world.commandInbox as Array<unknown>): CommandResult[] {
  const results: CommandResult[] = [];
  for (const envelope of inbox) {
    results.push(processCommand(world, envelope));
  }
  if (world.commandInbox === inbox) {
    world.commandInbox = [];
  }
  return results;
}

export function createCommandEnvelope(actorId: PlayerId, actorSequence: number, issuedTick: number, command: GameplayCommand): CommandEnvelope {
  return {
    commandId: parseCommandId(`command_${actorId}_${actorSequence}`),
    actorId,
    actorSequence,
    issuedTick,
    command,
  };
}

export function createCommandIdValue(actorId: PlayerId, actorSequence: number): CommandId {
  return createCommandId(`command_${actorId}_${actorSequence}`);
}

export function enqueueCommand(world: WorldState, envelope: CommandEnvelope): void {
  world.commandInbox = [...(world.commandInbox ?? []), envelope];
}

export function advanceSimulationTick(world: WorldState, inputs: Readonly<Record<string, PlayerInputState>> = {}): boolean {
  if (world.paused) return false;
  const playerIds = Object.keys(world.players).sort((left, right) => left < right ? -1 : left > right ? 1 : 0) as PlayerId[];
  for (const playerId of playerIds) {
    const player = world.players[playerId];
    if (!player) continue;
    const input = inputs?.[playerId] ?? player.input;
    if (input) {
      player.input.left = Boolean(input.left);
      player.input.right = Boolean(input.right);
      player.input.jumpHeld = Boolean(input.jumpHeld);
      player.input.crouchHeld = Boolean(input.crouchHeld);
      player.input.lookUpHeld = Boolean(input.lookUpHeld);
      player.input.mineHeld = Boolean(input.mineHeld);
    }
  }
  world.tick += 1;
  return true;
}

interface PlayerInputState {
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  crouchHeld: boolean;
  lookUpHeld: boolean;
  mineHeld: boolean;
}
