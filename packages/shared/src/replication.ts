import { assertAuxiliaryValueForMaterial, Grid } from "./grid.js";
import { parseObjectId, parsePlayerId, parseRoomId } from "./ids.js";
import { MaterialId, MATERIALS } from "./materials.js";
import { DAY_NIGHT_CYCLE_TICKS } from "./gameplay.js";
import { deserializeWorldState, serializeWorldState, WORLD_STATE_SCHEMA_VERSION, validateCommandReceipt, type WorldStateDto, type PlayerStateDto, type FallingObjectStateDto, type WeatherStateDto, type CommandLedgerDto, type GameplayRandomStateDto } from "./serialization.js";
import { createDefaultWorldState, type WorldState, type WeatherState } from "./world-state.js";
import type { CommandEnvelope } from "./commands.js";
import { type DirtyCellEntry } from "./dirty-journal.js";
import { createGameplayRandomState, type GameplayRandomState } from "./random.js";
import type { CommandReceipt } from "./commands.js";

export const WORLD_SNAPSHOT_SCHEMA_VERSION = 1;

const MAX_DELTA_CELLS = 4096;
const MAX_DELTA_PLAYERS = 256;
const MAX_DELTA_FALLING_OBJECTS = 256;
const MAX_DELTA_METADATA = 32;
const MAX_SAFE_INTEGER = 0x1_0000_0000 - 1;
const MAX_GRID_CELLS = 1_000_000;

export interface WorldSnapshot {
  version: typeof WORLD_SNAPSHOT_SCHEMA_VERSION;
  worldRevision: number;
  checksum: string;
  worldState: WorldStateDto;
}

export interface WorldSnapshotMetrics {
  checksum: string;
  snapshotByteSize: number;
  dirtyCellCount: number;
}

export interface WorldCellDelta {
  index: number;
  materialId: MaterialId;
  shade: number;
  auxiliary: number;
  objectId: string | null;
  revision: number;
}

export interface WorldPlayerDelta {
  playerId: string;
  state: PlayerStateDto | null;
}

export interface WorldFallingObjectDelta {
  objectId: string;
  state: FallingObjectStateDto | null;
}

export interface WorldMetadataDelta {
  field: "roomId" | "tick" | "paused" | "time" | "weather" | "random" | "ownerPlayerId" | "worldRevision" | "nextAuthorityOrder" | "nextPlayerOrdinal" | "nextObjectOrdinal" | "commandLedger";
  value: unknown;
}

export interface CommandLedgerDeltaValue {
  kind: "incremental";
  actorHighWater: Record<string, number>;
  appendedReceipts: CommandReceipt[];
  trimmedCount: number;
}

export interface WorldDeltaBuildOptions {
  dirtyCellEntries?: DirtyCellEntry[];
  publishedCellRevisions?: ReadonlyMap<number, number>;
  commandLedgerDelta?: CommandLedgerDeltaValue | null;
}

export interface WorldDelta {
  version: typeof WORLD_SNAPSHOT_SCHEMA_VERSION;
  baseRevision: number;
  targetRevision: number;
  gridDimensions?: {
    width: number;
    height: number;
  };
  cells: WorldCellDelta[];
  players: WorldPlayerDelta[];
  fallingObjects: WorldFallingObjectDelta[];
  metadata: WorldMetadataDelta[];
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function assertInteger(value: unknown, label: string, min?: number, max?: number): number {
  const finite = assertFiniteNumber(value, label);
  if (!Number.isInteger(finite)) {
    throw new TypeError(`${label} must be an integer`);
  }
  if (min !== undefined && finite < min) {
    throw new TypeError(`${label} must be >= ${min}`);
  }
  if (max !== undefined && finite > max) {
    throw new TypeError(`${label} must be <= ${max}`);
  }
  return finite;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function compareStringCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function areInventoryCountsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

function areHotbarItemsEqual(left: PlayerStateDto["hotbar"], right: PlayerStateDto["hotbar"]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (leftEntry === null || rightEntry === null) {
      if (leftEntry !== rightEntry) {
        return false;
      }
      continue;
    }
    if (leftEntry.kind !== rightEntry.kind) {
      return false;
    }
    if (leftEntry.kind === "material" && rightEntry.kind === "material") {
      if (leftEntry.materialId !== rightEntry.materialId || leftEntry.count !== rightEntry.count) {
        return false;
      }
    }
  }
  return true;
}

function arePendingRefundsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

function arePlayerStatesEqual(left: PlayerStateDto, right: PlayerStateDto): boolean {
  return left.id === right.id
    && left.x === right.x
    && left.y === right.y
    && left.vx === right.vx
    && left.vy === right.vy
    && left.width === right.width
    && left.height === right.height
    && left.grounded === right.grounded
    && left.facing === right.facing
    && left.airTicks === right.airTicks
    && left.previousJumpHeld === right.previousJumpHeld
    && left.swingElapsedTicks === right.swingElapsedTicks
    && left.faucetCooldownUntilTick === right.faucetCooldownUntilTick
    && left.crouching === right.crouching
    && left.lookingUp === right.lookingUp
    && left.swimming === right.swimming
    && left.input.left === right.input.left
    && left.input.right === right.input.right
    && left.input.jumpHeld === right.input.jumpHeld
    && left.input.crouchHeld === right.input.crouchHeld
    && left.input.lookUpHeld === right.input.lookUpHeld
    && left.input.mineHeld === right.input.mineHeld
    && areInventoryCountsEqual(left.inventory, right.inventory)
    && areHotbarItemsEqual(left.hotbar, right.hotbar)
    && left.activeHotbarSlot === right.activeHotbarSlot
    && left.inventoryRevision === right.inventoryRevision
    && arePendingRefundsEqual(left.pendingRefunds, right.pendingRefunds);
}

function areFallingObjectStatesEqual(left: FallingObjectStateDto, right: FallingObjectStateDto): boolean {
  if (left.id !== right.id || left.materialId !== right.materialId || left.x !== right.x || left.y !== right.y || left.restY !== right.restY || left.vy !== right.vy || left.offsets.length !== right.offsets.length) {
    return false;
  }
  for (let index = 0; index < left.offsets.length; index += 1) {
    const [leftDx, leftDy] = left.offsets[index];
    const [rightDx, rightDy] = right.offsets[index];
    if (leftDx !== rightDx || leftDy !== rightDy) {
      return false;
    }
  }
  if (left.provenance.kind !== right.provenance.kind) {
    return false;
  }
  if (left.provenance.kind === "placement" && right.provenance.kind === "placement") {
    return left.provenance.actorId === right.provenance.actorId
      && left.provenance.commandId === right.provenance.commandId
      && left.provenance.sourceSlot === right.provenance.sourceSlot
      && left.provenance.materialId === right.provenance.materialId
      && left.provenance.amount === right.provenance.amount;
  }
  return true;
}

function areWeatherStatesEqual(left: WeatherStateDto, right: WeatherStateDto): boolean {
  return left.kind === right.kind
    && left.episodeElapsed === right.episodeElapsed
    && left.episodeDuration === right.episodeDuration
    && left.wind === right.wind
    && left.visualTime === right.visualTime
    && left.rainAccumulator === right.rainAccumulator
    && left.lightningFlash === right.lightningFlash
    && left.lightningCooldown === right.lightningCooldown
    && left.boltX === right.boltX
    && left.boltY === right.boltY
    && left.boltSeed === right.boltSeed;
}

function areGameplayRandomStatesEqual(left: GameplayRandomStateDto, right: GameplayRandomStateDto): boolean {
  return left.algorithm === right.algorithm && left.seed === right.seed && left.state === right.state;
}

function areCommandLedgerStatesEqual(left: CommandLedgerDto, right: CommandLedgerDto): boolean {
  if (left.actorHighWater === right.actorHighWater) {
    return true;
  }
  const leftActorIds = Object.keys(left.actorHighWater);
  const rightActorIds = Object.keys(right.actorHighWater);
  if (leftActorIds.length !== rightActorIds.length) {
    return false;
  }
  for (const actorId of leftActorIds) {
    if (left.actorHighWater[actorId] !== right.actorHighWater[actorId]) {
      return false;
    }
  }
  if (left.recent.length !== right.recent.length) {
    return false;
  }
  for (let index = 0; index < left.recent.length; index += 1) {
    if (!areCommandReceiptsEqual(left.recent[index], right.recent[index])) {
      return false;
    }
  }
  return true;
}

function areMetadataValuesEqual(field: WorldMetadataDelta["field"], left: unknown, right: unknown): boolean {
  switch (field) {
    case "roomId":
      return left === right;
    case "tick":
    case "worldRevision":
    case "nextAuthorityOrder":
    case "nextPlayerOrdinal":
    case "nextObjectOrdinal":
      return left === right;
    case "paused":
      return left === right;
    case "time":
      return typeof left === "object" && left !== null && typeof right === "object" && right !== null && (left as { dayNightTick: number }).dayNightTick === (right as { dayNightTick: number }).dayNightTick;
    case "weather":
      return typeof left === "object" && left !== null && typeof right === "object" && right !== null && areWeatherStatesEqual(left as WeatherStateDto, right as WeatherStateDto);
    case "random":
      return typeof left === "object" && left !== null && typeof right === "object" && right !== null && areGameplayRandomStatesEqual(left as GameplayRandomStateDto, right as GameplayRandomStateDto);
    case "ownerPlayerId":
      return left === right;
    case "commandLedger":
      return typeof left === "object" && left !== null && typeof right === "object" && right !== null && areCommandLedgerStatesEqual(left as CommandLedgerDto, right as CommandLedgerDto);
    default:
      return false;
  }
}

function areCommandReceiptsEqual(left: CommandReceipt, right: CommandReceipt): boolean {
  return left.commandId === right.commandId
    && left.actorId === right.actorId
    && left.actorSequence === right.actorSequence
    && left.authorityOrder === right.authorityOrder
    && left.issuedTick === right.issuedTick
    && left.processedTick === right.processedTick
    && left.commandType === right.commandType
    && left.code === right.code
    && left.accepted === right.accepted
    && left.beforeWorldRevision === right.beforeWorldRevision
    && left.afterWorldRevision === right.afterWorldRevision
    && left.beforeInventoryRevision === right.beforeInventoryRevision
    && left.afterInventoryRevision === right.afterInventoryRevision
    && left.beforeTargetRevision === right.beforeTargetRevision
    && left.afterTargetRevision === right.afterTargetRevision
    && left.acceptedEffect === right.acceptedEffect
    && left.fingerprint === right.fingerprint;
}

function clonePlainObject<T>(value: T): T {
  return cloneObjectTree(value);
}

function cloneObjectTree<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneObjectTree(entry)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const clone = {} as Record<string, unknown>;
    for (const [key, entry] of Object.entries(objectValue)) {
      clone[key] = cloneObjectTree(entry);
    }
    return clone as unknown as T;
  }
  return value;
}

function createImmutableClone<T>(value: T): T {
  if (Array.isArray(value)) {
    const clone = [] as unknown[];
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      clone[index] = createImmutableClone(value[index]);
    }
    for (let index = 0; index < length; index += 1) {
      const child = clone[index];
      Object.defineProperty(clone, index, {
        enumerable: true,
        configurable: true,
        get: () => child,
        set: () => undefined,
      });
    }
    Object.defineProperty(clone, "push", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => length,
    });
    Object.defineProperty(clone, "pop", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => undefined,
    });
    Object.defineProperty(clone, "shift", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => undefined,
    });
    Object.defineProperty(clone, "unshift", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => length,
    });
    Object.defineProperty(clone, "splice", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => [],
    });
    Object.defineProperty(clone, "sort", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => clone,
    });
    Object.defineProperty(clone, "reverse", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => clone,
    });
    Object.defineProperty(clone, "fill", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => clone,
    });
    Object.defineProperty(clone, "copyWithin", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => clone,
    });
    return clone as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const clone = Object.create(Object.getPrototypeOf(objectValue)) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(objectValue)) {
      const child = createImmutableClone(entry);
      Object.defineProperty(clone, key, {
        enumerable: true,
        configurable: true,
        get: () => child,
        set: () => undefined,
      });
    }
    return clone as unknown as T;
  }
  return value;
}

export function cloneDeltaValue<T>(value: T): T {
  return cloneObjectTree(value);
}

function cloneImmutableDeltaValue<T>(value: T): T {
  return createImmutableClone(value);
}

function cloneDeltaValueForPublication<T>(value: T): T {
  return cloneImmutableDeltaValue(value);
}

function cloneGridState(grid: Grid): Grid {
  const clone = new Grid(grid.width, grid.height);
  clone.ids = new Uint8Array(grid.ids);
  clone.shade = new Int8Array(grid.shade);
  clone.auxiliary = new Int8Array(grid.auxiliary);
  clone.objectIds = Array.from(grid.objectIds);
  clone.cellRevisions = new Uint32Array(grid.cellRevisions);
  (clone as unknown as { updated: Uint8Array }).updated = new Uint8Array(grid.width * grid.height);
  const cloneState = clone as unknown as { objectCellIndex: Map<string, Set<number>>; updated: Uint8Array };
  cloneState.objectCellIndex = new Map<string, Set<number>>();
  for (let index = 0; index < clone.objectIds.length; index += 1) {
    const objectId = clone.objectIds[index];
    if (!objectId) continue;
    let cells = cloneState.objectCellIndex.get(objectId);
    if (!cells) {
      cells = new Set<number>();
      cloneState.objectCellIndex.set(objectId, cells);
    }
    cells.add(index);
  }
  clone.dirtyCells.clear();
  return clone;
}

export function cloneWorldState(world: WorldState): WorldState {
  const grid = cloneGridState(world.grid);
  const clone = createDefaultWorldState(world.roomId, grid);
  clone.roomId = world.roomId;
  clone.grid = grid;
  clone.random = clonePlainObject(world.random);
  clone.players = Object.fromEntries(Object.entries(world.players).map(([playerId, player]) => [playerId, clonePlainObject(player)]));
  clone.fallingObjects = Object.fromEntries(Object.entries(world.fallingObjects).map(([objectId, fallingObject]) => [objectId, clonePlainObject(fallingObject)]));
  clone.paused = world.paused;
  clone.tick = world.tick;
  clone.time = clonePlainObject(world.time);
  clone.weather = clonePlainObject(world.weather);
  clone.nextPlayerOrdinal = world.nextPlayerOrdinal;
  clone.nextObjectOrdinal = world.nextObjectOrdinal;
  clone.ownerPlayerId = world.ownerPlayerId;
  clone.worldRevision = world.worldRevision;
  clone.nextAuthorityOrder = world.nextAuthorityOrder;
  clone.commandLedger = {
    actorHighWater: { ...world.commandLedger.actorHighWater },
    recent: world.commandLedger.recent.map((receipt) => clonePlainObject(receipt)),
  };
  clone.commandInbox = (world.commandInbox ?? []).map((envelope) => clonePlainObject(envelope as CommandEnvelope));
  return clone;
}

export function cloneWorldSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  return {
    version: snapshot.version,
    worldRevision: snapshot.worldRevision,
    checksum: snapshot.checksum,
    worldState: clonePlainObject(snapshot.worldState),
  };
}

export function cloneWorldDelta(delta: WorldDelta): WorldDelta {
  return cloneObjectTree(delta);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareStringCodeUnits(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1aHex(input: string): string {
  let output = "";
  for (let iteration = 0; iteration < 8; iteration += 1) {
    let hash = 0x811c_9dc5;
    const seed = `${input}:${iteration}`;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x0100_0193);
    }
    output += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return output;
}

function validateMaterialId(value: unknown, _label: string): MaterialId {
  const materialId = assertInteger(value, _label, 0, 255) as MaterialId;
  if (!Object.prototype.hasOwnProperty.call(MATERIALS, materialId)) {
    throw new TypeError(`${_label} must reference a known material`);
  }
  return materialId;
}

function validateObjectId(value: unknown, _label: string): string {
  return parseObjectId(value);
}

function validatePlayerId(value: unknown, _label: string): string {
  return parsePlayerId(value);
}

function validateRoomId(value: unknown, _label: string): string {
  return parseRoomId(value);
}

function validateGridDimensions(value: unknown, label: string): { width: number; height: number } {
  const obj = assertObject(value, label);
  const width = assertInteger(requireField(obj, "width", `${label}.width`), `${label}.width`, 1, 10000);
  const height = assertInteger(requireField(obj, "height", `${label}.height`), `${label}.height`, 1, 10000);
  const totalCells = width * height;
  if (totalCells > MAX_GRID_CELLS) {
    throw new TypeError(`${label} exceeds the maximum allowed cell count`);
  }
  return { width, height };
}

function requireField<T>(obj: Record<string, unknown>, key: string, label: string): T {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    throw new TypeError(`${label} is required`);
  }
  return obj[key] as T;
}

function validateCellDelta(value: unknown): WorldCellDelta {
  const obj = assertObject(value, "cell delta");
  const index = assertInteger(requireField(obj, "index", "cellDelta.index"), "cellDelta.index", 0, MAX_SAFE_INTEGER);
  const materialId = validateMaterialId(requireField(obj, "materialId", "cellDelta.materialId"), "cellDelta.materialId");
  const shade = assertInteger(requireField(obj, "shade", "cellDelta.shade"), "cellDelta.shade", -128, 127);
  const auxiliary = assertInteger(requireField(obj, "auxiliary", "cellDelta.auxiliary"), "cellDelta.auxiliary", -128, 127);
  const objectIdValue = requireField(obj, "objectId", "cellDelta.objectId");
  const objectId = objectIdValue === null ? null : validateObjectId(objectIdValue, "cellDelta.objectId");
  const revision = assertInteger(requireField(obj, "revision", "cellDelta.revision"), "cellDelta.revision", 0, MAX_SAFE_INTEGER);
  if (materialId === MaterialId.Empty) {
    if (shade !== 0 || auxiliary !== 0 || objectId !== null) {
      throw new TypeError("cellDelta must use canonical empty values for empty material cells");
    }
  } else if (MATERIALS[materialId].placement.kind !== "object") {
    if (objectId !== null) {
      throw new TypeError("cellDelta.objectId is only valid for object-placement materials");
    }
  } else if (objectId === null) {
    throw new TypeError("cellDelta.objectId is required for object-placement materials");
  }
  return {
    index,
    materialId,
    shade,
    auxiliary: assertAuxiliaryValueForMaterial(materialId, auxiliary),
    objectId,
    revision,
  };
}

function validatePlayerStateDto(value: unknown): PlayerStateDto {
  const obj = assertObject(value, "player delta state");
  const playerId = validatePlayerId(requireField(obj, "id", "playerDelta.state.id"), "playerDelta.state.id");
  const inventory = cloneDeltaValueForPublication(assertObject(requireField(obj, "inventory", "playerDelta.state.inventory"), "playerDelta.state.inventory"));
  for (const [key, entry] of Object.entries(inventory)) {
    if (key === "flowers") {
      assertInteger(entry, `playerDelta.state.inventory.${key}`, 0, 1000000);
    } else {
      assertInteger(entry, `playerDelta.state.inventory.${key}`, 0, 1000000);
    }
  }
  const hotbar = requireField(obj, "hotbar", "playerDelta.state.hotbar");
  const hotbarValues = assertArray(hotbar, "playerDelta.state.hotbar");
  if (hotbarValues.length !== 10) {
    throw new TypeError("playerDelta.state.hotbar must contain exactly 10 slots");
  }
  const activeHotbarSlot = assertInteger(requireField(obj, "activeHotbarSlot", "playerDelta.state.activeHotbarSlot"), "playerDelta.state.activeHotbarSlot", 0, 9);
  const input = cloneDeltaValueForPublication(assertObject(requireField(obj, "input", "playerDelta.state.input"), "playerDelta.state.input"));
  assertBoolean(input["left"], "playerDelta.state.input.left");
  assertBoolean(input["right"], "playerDelta.state.input.right");
  assertBoolean(input["jumpHeld"], "playerDelta.state.input.jumpHeld");
  assertBoolean(input["crouchHeld"], "playerDelta.state.input.crouchHeld");
  assertBoolean(input["lookUpHeld"], "playerDelta.state.input.lookUpHeld");
  assertBoolean(input["mineHeld"], "playerDelta.state.input.mineHeld");
  const pendingRefunds = cloneDeltaValueForPublication(assertObject(requireField(obj, "pendingRefunds", "playerDelta.state.pendingRefunds"), "playerDelta.state.pendingRefunds"));
  for (const [, entry] of Object.entries(pendingRefunds)) {
    assertInteger(entry, "playerDelta.state.pendingRefunds.*", 0, 1000000);
  }
  const facingValue = requireField(obj, "facing", "playerDelta.state.facing");
  if (facingValue !== -1 && facingValue !== 1) {
    throw new TypeError("playerDelta.state.facing must be -1 or 1");
  }
  const state: PlayerStateDto = {
    id: playerId,
    x: assertFiniteNumber(requireField(obj, "x", "playerDelta.state.x"), "playerDelta.state.x"),
    y: assertFiniteNumber(requireField(obj, "y", "playerDelta.state.y"), "playerDelta.state.y"),
    vx: assertFiniteNumber(requireField(obj, "vx", "playerDelta.state.vx"), "playerDelta.state.vx"),
    vy: assertFiniteNumber(requireField(obj, "vy", "playerDelta.state.vy"), "playerDelta.state.vy"),
    width: assertFiniteNumber(requireField(obj, "width", "playerDelta.state.width"), "playerDelta.state.width"),
    height: assertFiniteNumber(requireField(obj, "height", "playerDelta.state.height"), "playerDelta.state.height"),
    grounded: assertBoolean(requireField(obj, "grounded", "playerDelta.state.grounded"), "playerDelta.state.grounded"),
    facing: facingValue as -1 | 1,
    airTicks: assertInteger(requireField(obj, "airTicks", "playerDelta.state.airTicks"), "playerDelta.state.airTicks", 0, MAX_SAFE_INTEGER),
    previousJumpHeld: assertBoolean(requireField(obj, "previousJumpHeld", "playerDelta.state.previousJumpHeld"), "playerDelta.state.previousJumpHeld"),
    swingElapsedTicks: requireField(obj, "swingElapsedTicks", "playerDelta.state.swingElapsedTicks") === null ? null : assertInteger(requireField(obj, "swingElapsedTicks", "playerDelta.state.swingElapsedTicks"), "playerDelta.state.swingElapsedTicks", 0, MAX_SAFE_INTEGER),
    faucetCooldownUntilTick: assertInteger(requireField(obj, "faucetCooldownUntilTick", "playerDelta.state.faucetCooldownUntilTick"), "playerDelta.state.faucetCooldownUntilTick", 0, MAX_SAFE_INTEGER),
    crouching: assertBoolean(requireField(obj, "crouching", "playerDelta.state.crouching"), "playerDelta.state.crouching"),
    lookingUp: assertBoolean(requireField(obj, "lookingUp", "playerDelta.state.lookingUp"), "playerDelta.state.lookingUp"),
    swimming: assertBoolean(requireField(obj, "swimming", "playerDelta.state.swimming"), "playerDelta.state.swimming"),
    input: {
      left: Boolean(input["left"]),
      right: Boolean(input["right"]),
      jumpHeld: Boolean(input["jumpHeld"]),
      crouchHeld: Boolean(input["crouchHeld"]),
      lookUpHeld: Boolean(input["lookUpHeld"]),
      mineHeld: Boolean(input["mineHeld"]),
    },
    inventory: inventory as PlayerStateDto["inventory"],
    hotbar: hotbarValues.map((entry) => cloneDeltaValueForPublication(entry) as PlayerStateDto["hotbar"][number]),
    activeHotbarSlot,
    inventoryRevision: assertInteger(requireField(obj, "inventoryRevision", "playerDelta.state.inventoryRevision"), "playerDelta.state.inventoryRevision", 0, MAX_SAFE_INTEGER),
    pendingRefunds: pendingRefunds as Record<string, number>,
  };
  return state;
}

function validateFallingObjectStateDto(value: unknown): FallingObjectStateDto {
  const obj = assertObject(value, "falling object delta state");
  const objectId = validateObjectId(requireField(obj, "id", "fallingObjectDelta.state.id"), "fallingObjectDelta.state.id");
  const materialId = validateMaterialId(requireField(obj, "materialId", "fallingObjectDelta.state.materialId"), "fallingObjectDelta.state.materialId");
  if (MATERIALS[materialId].placement.kind !== "object") {
    throw new TypeError("fallingObjectDelta.state.materialId must reference an object material");
  }
  const offsets = assertArray(requireField(obj, "offsets", "fallingObjectDelta.state.offsets"), "fallingObjectDelta.state.offsets");
  const normalizedOffsets: [number, number][] = [];
  for (const entry of offsets) {
    const pair = assertArray(entry, "fallingObjectDelta.state.offsets[]");
    if (pair.length !== 2) {
      throw new TypeError("fallingObjectDelta.state.offsets[] entries must have length 2");
    }
    normalizedOffsets.push([assertInteger(pair[0], "fallingObjectDelta.state.offsets[0]"), assertInteger(pair[1], "fallingObjectDelta.state.offsets[1]")] as [number, number]);
  }
  return {
    id: objectId,
    materialId,
    x: assertInteger(requireField(obj, "x", "fallingObjectDelta.state.x"), "fallingObjectDelta.state.x"),
    y: assertFiniteNumber(requireField(obj, "y", "fallingObjectDelta.state.y"), "fallingObjectDelta.state.y"),
    restY: assertInteger(requireField(obj, "restY", "fallingObjectDelta.state.restY"), "fallingObjectDelta.state.restY"),
    vy: assertFiniteNumber(requireField(obj, "vy", "fallingObjectDelta.state.vy"), "fallingObjectDelta.state.vy"),
    offsets: normalizedOffsets.map((entry) => [...entry] as [number, number]),
    provenance: cloneDeltaValueForPublication(requireField(obj, "provenance", "fallingObjectDelta.state.provenance")) as FallingObjectStateDto["provenance"],
  };
}

function validateWeatherStateDto(value: unknown): WeatherStateDto {
  const obj = assertObject(value, "weather delta state");
  return {
    kind: requireField(obj, "kind", "weatherDelta.state.kind") as WeatherState["kind"],
    episodeElapsed: assertFiniteNumber(requireField(obj, "episodeElapsed", "weatherDelta.state.episodeElapsed"), "weatherDelta.state.episodeElapsed"),
    episodeDuration: assertFiniteNumber(requireField(obj, "episodeDuration", "weatherDelta.state.episodeDuration"), "weatherDelta.state.episodeDuration"),
    wind: assertFiniteNumber(requireField(obj, "wind", "weatherDelta.state.wind"), "weatherDelta.state.wind"),
    visualTime: assertFiniteNumber(requireField(obj, "visualTime", "weatherDelta.state.visualTime"), "weatherDelta.state.visualTime"),
    rainAccumulator: assertFiniteNumber(requireField(obj, "rainAccumulator", "weatherDelta.state.rainAccumulator"), "weatherDelta.state.rainAccumulator"),
    lightningFlash: requireField(obj, "lightningFlash", "weatherDelta.state.lightningFlash") === null ? null : assertFiniteNumber(requireField(obj, "lightningFlash", "weatherDelta.state.lightningFlash"), "weatherDelta.state.lightningFlash"),
    lightningCooldown: requireField(obj, "lightningCooldown", "weatherDelta.state.lightningCooldown") === null ? null : assertFiniteNumber(requireField(obj, "lightningCooldown", "weatherDelta.state.lightningCooldown"), "weatherDelta.state.lightningCooldown"),
    boltX: requireField(obj, "boltX", "weatherDelta.state.boltX") === null ? null : assertFiniteNumber(requireField(obj, "boltX", "weatherDelta.state.boltX"), "weatherDelta.state.boltX"),
    boltY: requireField(obj, "boltY", "weatherDelta.state.boltY") === null ? null : assertFiniteNumber(requireField(obj, "boltY", "weatherDelta.state.boltY"), "weatherDelta.state.boltY"),
    boltSeed: assertFiniteNumber(requireField(obj, "boltSeed", "weatherDelta.state.boltSeed"), "weatherDelta.state.boltSeed"),
  };
}

function validateCommandLedgerDto(value: unknown): CommandLedgerDto {
  const obj = assertObject(value, "commandLedger delta state");
  const actorHighWater = cloneDeltaValueForPublication(assertObject(requireField(obj, "actorHighWater", "commandLedgerDelta.state.actorHighWater"), "commandLedgerDelta.state.actorHighWater"));
  const recent = assertArray(requireField(obj, "recent", "commandLedgerDelta.state.recent"), "commandLedgerDelta.state.recent");
  const normalized: CommandLedgerDto = { actorHighWater: {}, recent: [] };
  for (const [key, entry] of Object.entries(actorHighWater)) {
    normalized.actorHighWater[key] = assertInteger(entry, `commandLedgerDelta.state.actorHighWater.${key}`, 0, MAX_SAFE_INTEGER);
  }
  for (const item of recent) {
    normalized.recent.push(validateCommandReceipt(item, "commandLedgerDelta.state.recent[]") as unknown as CommandLedgerDto["recent"][number]);
  }
  return normalized;
}

function validateCommandLedgerDeltaValue(value: unknown): CommandLedgerDeltaValue {
  const obj = assertObject(value, "commandLedger delta value");
  if (obj["kind"] !== "incremental") {
    throw new TypeError("commandLedger delta value must use kind=incremental");
  }
  const actorHighWater = cloneDeltaValueForPublication(assertObject(requireField(obj, "actorHighWater", "commandLedgerDelta.actorHighWater"), "commandLedgerDelta.actorHighWater"));
  const appendedReceipts = assertArray(requireField(obj, "appendedReceipts", "commandLedgerDelta.appendedReceipts"), "commandLedgerDelta.appendedReceipts");
  const trimmedCount = assertInteger(requireField(obj, "trimmedCount", "commandLedgerDelta.trimmedCount"), "commandLedgerDelta.trimmedCount", 0, MAX_SAFE_INTEGER);
  const normalized: CommandLedgerDeltaValue = { kind: "incremental", actorHighWater: {}, appendedReceipts: [], trimmedCount };
  for (const [key, entry] of Object.entries(actorHighWater)) {
    normalized.actorHighWater[key] = assertInteger(entry, `commandLedgerDelta.actorHighWater.${key}`, 0, MAX_SAFE_INTEGER);
  }
  for (const item of appendedReceipts) {
    normalized.appendedReceipts.push(validateCommandReceipt(item, "commandLedgerDelta.appendedReceipts[]") as unknown as CommandReceipt);
  }
  return normalized;
}

function validateCommandLedgerMetadataValue(value: unknown): CommandLedgerDto | CommandLedgerDeltaValue {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>)["kind"] === "incremental") {
    return validateCommandLedgerDeltaValue(value);
  }
  return validateCommandLedgerDto(value);
}

function validateGameplayRandomStateDto(value: unknown): GameplayRandomState {
  const obj = assertObject(value, "random delta state");
  const algorithm = requireField(obj, "algorithm", "randomDelta.state.algorithm");
  if (algorithm !== "mulberry32-v1") {
    throw new TypeError("randomDelta.state.algorithm must be 'mulberry32-v1'");
  }
  const seed = assertInteger(requireField(obj, "seed", "randomDelta.state.seed"), "randomDelta.state.seed", 0, MAX_SAFE_INTEGER);
  const state = assertInteger(requireField(obj, "state", "randomDelta.state.state"), "randomDelta.state.state", 0, MAX_SAFE_INTEGER);
  const random = createGameplayRandomState(seed);
  random.state = state;
  return random;
}

function validateWorldSnapshotMetadataField(field: string, value: unknown): WorldMetadataDelta {
  switch (field) {
    case "roomId":
      return { field: field as WorldMetadataDelta["field"], value: validateRoomId(value, "worldDelta.metadata[].value") };
    case "tick":
      return { field: field as WorldMetadataDelta["field"], value: assertInteger(value, "worldDelta.metadata[].value", 0, MAX_SAFE_INTEGER) };
    case "paused":
      return { field: field as WorldMetadataDelta["field"], value: assertBoolean(value, "worldDelta.metadata[].value") };
    case "time": {
      const obj = assertObject(value, "worldDelta.metadata[].value");
      const dayNightTick = assertInteger(requireField(obj, "dayNightTick", "worldDelta.metadata[].value.dayNightTick"), "worldDelta.metadata[].value.dayNightTick", 0, DAY_NIGHT_CYCLE_TICKS - 1);
      return { field: field as WorldMetadataDelta["field"], value: { dayNightTick } };
    }
    case "weather":
      return { field: field as WorldMetadataDelta["field"], value: validateWeatherStateDto(value) };
    case "random":
      return { field: field as WorldMetadataDelta["field"], value: validateGameplayRandomStateDto(value) };
    case "ownerPlayerId":
      return { field: field as WorldMetadataDelta["field"], value: value === null ? null : validatePlayerId(value, "worldDelta.metadata[].value") };
    case "worldRevision":
      return { field: field as WorldMetadataDelta["field"], value: assertInteger(value, "worldDelta.metadata[].value", 0, MAX_SAFE_INTEGER) };
    case "nextAuthorityOrder":
      return { field: field as WorldMetadataDelta["field"], value: assertInteger(value, "worldDelta.metadata[].value", 1, MAX_SAFE_INTEGER) };
    case "nextPlayerOrdinal":
      return { field: field as WorldMetadataDelta["field"], value: assertInteger(value, "worldDelta.metadata[].value", 1, MAX_SAFE_INTEGER) };
    case "nextObjectOrdinal":
      return { field: field as WorldMetadataDelta["field"], value: assertInteger(value, "worldDelta.metadata[].value", 1, MAX_SAFE_INTEGER) };
    case "commandLedger":
      return { field: field as WorldMetadataDelta["field"], value: validateCommandLedgerMetadataValue(value) };
    default:
      throw new TypeError("worldDelta.metadata[].field has an unsupported value");
  }
}

function serializePlayerState(player: WorldState["players"][string]): PlayerStateDto {
  return cloneDeltaValueForPublication(player) as PlayerStateDto;
}

function serializeFallingObjectState(objectState: WorldState["fallingObjects"][string]): FallingObjectStateDto {
  return cloneDeltaValueForPublication(objectState) as FallingObjectStateDto;
}

function buildCellDeltaEntries(world: WorldState, dirtyCellEntries: DirtyCellEntry[]): WorldCellDelta[] {
  const nextCells: WorldCellDelta[] = [];
  const grid = world.grid;
  for (const entry of dirtyCellEntries) {
    if (entry.index < 0 || entry.index >= grid.width * grid.height) continue;
    nextCells.push({
      index: entry.index,
      materialId: entry.materialId,
      shade: entry.shade,
      auxiliary: entry.auxiliary,
      objectId: entry.objectId,
      revision: entry.revision,
    });
  }
  return nextCells;
}

export function createCommandLedgerDelta(previousLedger: { actorHighWater: Record<string, number>; recent: ReadonlyArray<CommandReceipt> }, nextLedger: { actorHighWater: Record<string, number>; recent: ReadonlyArray<CommandReceipt> }): CommandLedgerDeltaValue | null {
  const previousRecent = Array.from(previousLedger.recent ?? []);
  const nextRecent = Array.from(nextLedger.recent ?? []);
  let overlapLength = 0;
  const maxOverlap = Math.min(previousRecent.length, nextRecent.length);
  for (let offset = 0; offset < maxOverlap; offset += 1) {
    const previousReceipt = previousRecent[previousRecent.length - 1 - offset];
    const nextReceipt = nextRecent[offset];
    if (previousReceipt === undefined || nextReceipt === undefined || !areCommandReceiptsEqual(previousReceipt, nextReceipt)) {
      break;
    }
    overlapLength = offset + 1;
  }
  const actorHighWater: Record<string, number> = {};
  const actorIds = new Set([...Object.keys(previousLedger.actorHighWater ?? {}), ...Object.keys(nextLedger.actorHighWater ?? {})]);
  for (const actorId of actorIds) {
    const previousValue = previousLedger.actorHighWater?.[actorId];
    const nextValue = nextLedger.actorHighWater?.[actorId];
    if (previousValue !== nextValue) {
      actorHighWater[actorId] = nextValue ?? 0;
    }
  }
  const appendedReceipts = nextRecent.slice(overlapLength).map((receipt) => cloneDeltaValueForPublication(receipt) as CommandReceipt);
  const trimmedCount = Math.max(0, previousRecent.length - overlapLength);
  const hasChanges = Object.keys(actorHighWater).length > 0 || trimmedCount > 0 || appendedReceipts.length > 0;
  if (!hasChanges) {
    return null;
  }
  return {
    kind: "incremental",
    actorHighWater,
    appendedReceipts,
    trimmedCount,
  };
}

export function createWorldDelta(previousSnapshot: WorldSnapshot, world: WorldState, options: WorldDeltaBuildOptions = {}): WorldDelta | null {
  const previousState = previousSnapshot.worldState;
  const cells = buildCellDeltaEntries(world, options.dirtyCellEntries ?? world.grid.dirtyCells.readPending());
  const filteredCells = options.publishedCellRevisions
    ? cells.filter((cell) => {
      const previousRevision = options.publishedCellRevisions?.get(cell.index);
      return previousRevision === undefined || cell.revision > previousRevision;
    })
    : cells;
  const players: WorldPlayerDelta[] = [];
  const playerIds = new Set([...Object.keys(previousState.players), ...Object.keys(world.players)]);
  for (const playerId of playerIds) {
    const previousPlayer = previousState.players[playerId];
    const nextPlayer = world.players[playerId];
    if (previousPlayer === undefined && nextPlayer === undefined) continue;
    if (previousPlayer === undefined) {
      players.push({ playerId, state: nextPlayer ? serializePlayerState(nextPlayer) : null });
      continue;
    }
    if (nextPlayer === undefined) {
      players.push({ playerId, state: null });
      continue;
    }
    if (!arePlayerStatesEqual(previousPlayer, nextPlayer)) {
      players.push({ playerId, state: serializePlayerState(nextPlayer) });
    }
  }
  const fallingObjects: WorldFallingObjectDelta[] = [];
  const objectIds = new Set([...Object.keys(previousState.fallingObjects), ...Object.keys(world.fallingObjects)]);
  for (const objectId of objectIds) {
    const previousObject = previousState.fallingObjects[objectId];
    const nextObject = world.fallingObjects[objectId];
    if (previousObject === undefined && nextObject === undefined) continue;
    if (previousObject === undefined) {
      fallingObjects.push({ objectId, state: nextObject ? serializeFallingObjectState(nextObject) : null });
      continue;
    }
    if (nextObject === undefined) {
      fallingObjects.push({ objectId, state: null });
      continue;
    }
    if (!areFallingObjectStatesEqual(previousObject, nextObject)) {
      fallingObjects.push({ objectId, state: serializeFallingObjectState(nextObject) });
    }
  }
  const metadata: WorldMetadataDelta[] = [];
  const metadataFields: Array<"roomId" | "tick" | "paused" | "time" | "weather" | "random" | "ownerPlayerId" | "worldRevision" | "nextAuthorityOrder" | "nextPlayerOrdinal" | "nextObjectOrdinal" | "commandLedger"> = ["roomId", "tick", "paused", "time", "weather", "random", "ownerPlayerId", "worldRevision", "nextAuthorityOrder", "nextPlayerOrdinal", "nextObjectOrdinal", "commandLedger"];
  const commandLedgerValue = options.commandLedgerDelta ?? createCommandLedgerDelta(previousState.commandLedger, world.commandLedger);
  for (const field of metadataFields) {
    const previousValue = previousState[field as keyof typeof previousState];
    const nextValue = field === "roomId"
      ? world.roomId
      : field === "tick"
        ? world.tick
        : field === "paused"
          ? world.paused
          : field === "time"
            ? world.time
            : field === "weather"
              ? world.weather
              : field === "random"
                ? world.random
                : field === "ownerPlayerId"
                  ? world.ownerPlayerId
                  : field === "worldRevision"
                    ? world.worldRevision
                    : field === "nextAuthorityOrder"
                      ? world.nextAuthorityOrder
                      : field === "nextPlayerOrdinal"
                        ? world.nextPlayerOrdinal
                        : field === "nextObjectOrdinal"
                          ? world.nextObjectOrdinal
                          : world.commandLedger;
    if (field === "commandLedger") {
      if (commandLedgerValue) {
        metadata.push({ field, value: cloneDeltaValueForPublication(commandLedgerValue) });
      }
      continue;
    }
    if (!areMetadataValuesEqual(field, previousValue, nextValue)) {
      metadata.push({ field, value: cloneDeltaValueForPublication(nextValue) });
    }
  }
  const hasNonCommandLedgerMetadata = metadata.some((entry) => entry.field !== "commandLedger");
  if (filteredCells.length === 0 && players.length === 0 && fallingObjects.length === 0 && !hasNonCommandLedgerMetadata) {
    return null;
  }
  const targetRevision = Math.max(previousSnapshot.worldRevision + 1, world.worldRevision);
  return {
    version: WORLD_SNAPSHOT_SCHEMA_VERSION,
    baseRevision: previousSnapshot.worldRevision,
    targetRevision,
    gridDimensions: {
      width: world.grid.width,
      height: world.grid.height,
    },
    cells: filteredCells,
    players,
    fallingObjects,
    metadata,
  };
}

function canonicalizeWorldStateDto(worldState: WorldStateDto): WorldStateDto {
  const restored = deserializeWorldState(worldState);
  return serializeWorldState(restored);
}

function validateWorldDelta(value: unknown): WorldDelta {
  const obj = assertObject(value, "world delta");
  const version = assertInteger(requireField(obj, "version", "worldDelta.version"), "worldDelta.version", 1, 1) as typeof WORLD_SNAPSHOT_SCHEMA_VERSION;
  const baseRevision = assertInteger(requireField(obj, "baseRevision", "worldDelta.baseRevision"), "worldDelta.baseRevision", 0, MAX_SAFE_INTEGER);
  const targetRevision = assertInteger(requireField(obj, "targetRevision", "worldDelta.targetRevision"), "worldDelta.targetRevision", 0, MAX_SAFE_INTEGER);
  if (targetRevision <= baseRevision) {
    throw new TypeError("worldDelta.targetRevision must be greater than baseRevision");
  }
  const gridDimensions = Object.prototype.hasOwnProperty.call(obj, "gridDimensions")
    ? validateGridDimensions(obj["gridDimensions"], "worldDelta.gridDimensions")
    : undefined;
  const metadata = (requireField(obj, "metadata", "worldDelta.metadata") as unknown[]).map((entry) => {
    const metadataObj = assertObject(entry, "worldDelta.metadata[]");
    const field = requireField(metadataObj, "field", "worldDelta.metadata[].field");
    if (typeof field !== "string") {
      throw new TypeError("worldDelta.metadata[].field must be a string");
    }
    const normalizedField = field as WorldMetadataDelta["field"];
    if (normalizedField !== "roomId" && normalizedField !== "tick" && normalizedField !== "paused" && normalizedField !== "time" && normalizedField !== "weather" && normalizedField !== "random" && normalizedField !== "ownerPlayerId" && normalizedField !== "worldRevision" && normalizedField !== "nextAuthorityOrder" && normalizedField !== "nextPlayerOrdinal" && normalizedField !== "nextObjectOrdinal" && normalizedField !== "commandLedger") {
      throw new TypeError("worldDelta.metadata[].field has an unsupported value");
    }
    const value = metadataObj["value"];
    return validateWorldSnapshotMetadataField(normalizedField, value);
  });
  const cells = (requireField(obj, "cells", "worldDelta.cells") as unknown[]).map((entry) => validateCellDelta(entry));
  const players = (requireField(obj, "players", "worldDelta.players") as unknown[]).map((entry) => {
    const playerObj = assertObject(entry, "worldDelta.players[]");
    const playerId = validatePlayerId(requireField(playerObj, "playerId", "worldDelta.players[].playerId"), "worldDelta.players[].playerId");
    const stateValue = requireField(playerObj, "state", "worldDelta.players[].state");
    const state = stateValue === null ? null : validatePlayerStateDto(stateValue);
    if (state !== null && playerId !== state.id) {
      throw new TypeError("worldDelta.players[].playerId must match playerDelta.state.id");
    }
    return { playerId, state };
  });
  const fallingObjects = (requireField(obj, "fallingObjects", "worldDelta.fallingObjects") as unknown[]).map((entry) => {
    const objectObj = assertObject(entry, "worldDelta.fallingObjects[]");
    const objectId = validateObjectId(requireField(objectObj, "objectId", "worldDelta.fallingObjects[].objectId"), "worldDelta.fallingObjects[].objectId");
    const stateValue = requireField(objectObj, "state", "worldDelta.fallingObjects[].state");
    const state = stateValue === null ? null : validateFallingObjectStateDto(stateValue);
    if (state !== null && objectId !== state.id) {
      throw new TypeError("worldDelta.fallingObjects[].objectId must match fallingObjectDelta.state.id");
    }
    return { objectId, state };
  });
  if (cells.length > MAX_DELTA_CELLS) {
    throw new TypeError("worldDelta.cells exceeds the maximum allowed size");
  }
  if (players.length > MAX_DELTA_PLAYERS) {
    throw new TypeError("worldDelta.players exceeds the maximum allowed size");
  }
  if (fallingObjects.length > MAX_DELTA_FALLING_OBJECTS) {
    throw new TypeError("worldDelta.fallingObjects exceeds the maximum allowed size");
  }
  if (metadata.length > MAX_DELTA_METADATA) {
    throw new TypeError("worldDelta.metadata exceeds the maximum allowed size");
  }
  const seenCells = new Set<number>();
  for (const cell of cells) {
    if (seenCells.has(cell.index)) {
      throw new TypeError("worldDelta.cells contains duplicate indices");
    }
    seenCells.add(cell.index);
  }
  const seenPlayers = new Set<string>();
  for (const player of players) {
    if (seenPlayers.has(player.playerId)) {
      throw new TypeError("worldDelta.players contains duplicate player IDs");
    }
    seenPlayers.add(player.playerId);
  }
  const seenObjects = new Set<string>();
  for (const object of fallingObjects) {
    if (seenObjects.has(object.objectId)) {
      throw new TypeError("worldDelta.fallingObjects contains duplicate object IDs");
    }
    seenObjects.add(object.objectId);
  }
  const seenMetadata = new Set<string>();
  for (const entry of metadata) {
    if (seenMetadata.has(entry.field)) {
      throw new TypeError("worldDelta.metadata contains duplicate fields");
    }
    seenMetadata.add(entry.field);
  }
  return {
    version,
    baseRevision,
    targetRevision,
    gridDimensions,
    cells: cells.sort((left, right) => left.index - right.index),
    players: players.sort((left, right) => compareStringCodeUnits(left.playerId, right.playerId)),
    fallingObjects: fallingObjects.sort((left, right) => compareStringCodeUnits(left.objectId, right.objectId)),
    metadata: metadata.sort((left, right) => compareStringCodeUnits(left.field, right.field)),
  };
}

function replaceGridMembership(grid: WorldStateDto["grid"], index: number, objectId: string | null): void {
  const x = index % grid.width;
  const y = Math.floor(index / grid.width);
  const normalized = grid.objectMembership.filter((entry) => entry.x !== x || entry.y !== y);
  if (objectId !== null) {
    normalized.push({ x, y, objectId });
  }
  grid.objectMembership = normalized;
}

function applyWorldDeltaToSnapshotStateInPlace(worldState: WorldStateDto, delta: WorldDelta): void {
  const grid = worldState.grid;
  const totalCells = grid.width * grid.height;
  for (const cellDelta of delta.cells) {
    if (cellDelta.index < 0 || cellDelta.index >= totalCells) {
      throw new TypeError("worldDelta cell index is out of bounds");
    }
    const currentRevision = grid.cellRevisions[cellDelta.index] ?? 0;
    if (cellDelta.revision <= currentRevision) {
      throw new TypeError("worldDelta cell revision is stale");
    }
    if (cellDelta.objectId !== null && Object.prototype.hasOwnProperty.call(worldState.fallingObjects, cellDelta.objectId)) {
      throw new TypeError("worldDelta cell objectId collides with a falling object identity");
    }
  }
  for (const cellDelta of delta.cells) {
    if (cellDelta.materialId === MaterialId.Empty && cellDelta.shade === 0 && cellDelta.auxiliary === 0 && cellDelta.objectId === null) {
      grid.cellRevisions[cellDelta.index] = cellDelta.revision;
      grid.ids[cellDelta.index] = MaterialId.Empty;
      grid.shade[cellDelta.index] = 0;
      grid.auxiliary[cellDelta.index] = 0;
      replaceGridMembership(grid, cellDelta.index, null);
      continue;
    }
    grid.cellRevisions[cellDelta.index] = cellDelta.revision;
    grid.ids[cellDelta.index] = cellDelta.materialId;
    grid.shade[cellDelta.index] = cellDelta.shade;
    grid.auxiliary[cellDelta.index] = assertAuxiliaryValueForMaterial(cellDelta.materialId, cellDelta.auxiliary);
    replaceGridMembership(grid, cellDelta.index, cellDelta.objectId);
  }
  for (const playerDelta of delta.players) {
    if (playerDelta.state === null) {
      delete worldState.players[playerDelta.playerId];
      continue;
    }
    worldState.players[playerDelta.playerId] = cloneDeltaValue(playerDelta.state);
  }
  for (const fallingObjectDelta of delta.fallingObjects) {
    if (fallingObjectDelta.state === null) {
      delete worldState.fallingObjects[fallingObjectDelta.objectId];
      continue;
    }
    worldState.fallingObjects[fallingObjectDelta.objectId] = cloneDeltaValue(fallingObjectDelta.state);
  }
  for (const metadataDelta of delta.metadata) {
    applyMetadataDelta(worldState, metadataDelta);
  }
  worldState.worldRevision = delta.targetRevision;
}

export function applyWorldDeltaToSnapshotState(worldState: WorldStateDto, delta: WorldDelta): void {
  const normalizedDelta = decodeWorldDelta(delta);
  if (worldState.worldRevision !== normalizedDelta.baseRevision) {
    throw new TypeError("worldDelta.baseRevision does not match the checkpoint revision");
  }
  if (normalizedDelta.gridDimensions !== undefined) {
    if (worldState.grid.width !== normalizedDelta.gridDimensions.width || worldState.grid.height !== normalizedDelta.gridDimensions.height) {
      throw new TypeError("worldDelta.gridDimensions does not match the checkpoint dimensions");
    }
  }
  const nextWorldState = cloneDeltaValue(worldState);
  applyWorldDeltaToSnapshotStateInPlace(nextWorldState, normalizedDelta);
  const canonicalWorldState = canonicalizeWorldStateDto(nextWorldState);
  Object.assign(worldState, canonicalWorldState);
}

export function applyWorldDeltaToSnapshotStateFast(worldState: WorldStateDto, delta: WorldDelta): void {
  if (worldState.worldRevision !== delta.baseRevision) {
    throw new TypeError("worldDelta.baseRevision does not match the checkpoint revision");
  }
  if (delta.gridDimensions !== undefined) {
    if (worldState.grid.width !== delta.gridDimensions.width || worldState.grid.height !== delta.gridDimensions.height) {
      throw new TypeError("worldDelta.gridDimensions does not match the checkpoint dimensions");
    }
  }
  const grid = worldState.grid;
  const totalCells = grid.width * grid.height;
  for (const cellDelta of delta.cells) {
    if (cellDelta.index < 0 || cellDelta.index >= totalCells) {
      throw new TypeError("worldDelta cell index is out of bounds");
    }
    const currentRevision = grid.cellRevisions[cellDelta.index] ?? 0;
    if (cellDelta.revision <= currentRevision) {
      throw new TypeError("worldDelta cell revision is stale");
    }
    if (cellDelta.objectId !== null && Object.prototype.hasOwnProperty.call(worldState.fallingObjects, cellDelta.objectId)) {
      throw new TypeError("worldDelta cell objectId collides with a falling object identity");
    }
  }
  for (const cellDelta of delta.cells) {
    if (cellDelta.materialId === MaterialId.Empty && cellDelta.shade === 0 && cellDelta.auxiliary === 0 && cellDelta.objectId === null) {
      grid.cellRevisions[cellDelta.index] = cellDelta.revision;
      grid.ids[cellDelta.index] = MaterialId.Empty;
      grid.shade[cellDelta.index] = 0;
      grid.auxiliary[cellDelta.index] = 0;
      replaceGridMembership(grid, cellDelta.index, null);
      continue;
    }
    grid.cellRevisions[cellDelta.index] = cellDelta.revision;
    grid.ids[cellDelta.index] = cellDelta.materialId;
    grid.shade[cellDelta.index] = cellDelta.shade;
    grid.auxiliary[cellDelta.index] = assertAuxiliaryValueForMaterial(cellDelta.materialId, cellDelta.auxiliary);
    replaceGridMembership(grid, cellDelta.index, cellDelta.objectId);
  }
  for (const playerDelta of delta.players) {
    if (playerDelta.state === null) {
      delete worldState.players[playerDelta.playerId];
      continue;
    }
    worldState.players[playerDelta.playerId] = playerDelta.state as WorldStateDto["players"][string];
  }
  for (const fallingObjectDelta of delta.fallingObjects) {
    if (fallingObjectDelta.state === null) {
      delete worldState.fallingObjects[fallingObjectDelta.objectId];
      continue;
    }
    worldState.fallingObjects[fallingObjectDelta.objectId] = fallingObjectDelta.state as WorldStateDto["fallingObjects"][string];
  }
  for (const metadataDelta of delta.metadata) {
    switch (metadataDelta.field) {
      case "roomId": {
        worldState.roomId = metadataDelta.value as typeof worldState.roomId;
        break;
      }
      case "tick": {
        worldState.tick = metadataDelta.value as typeof worldState.tick;
        break;
      }
      case "paused": {
        worldState.paused = metadataDelta.value as typeof worldState.paused;
        break;
      }
      case "time": {
        worldState.time = metadataDelta.value as typeof worldState.time;
        break;
      }
      case "weather": {
        worldState.weather = metadataDelta.value as typeof worldState.weather;
        break;
      }
      case "random": {
        worldState.random = metadataDelta.value as typeof worldState.random;
        break;
      }
      case "ownerPlayerId": {
        worldState.ownerPlayerId = metadataDelta.value as typeof worldState.ownerPlayerId;
        break;
      }
      case "worldRevision": {
        worldState.worldRevision = metadataDelta.value as typeof worldState.worldRevision;
        break;
      }
      case "nextAuthorityOrder": {
        worldState.nextAuthorityOrder = metadataDelta.value as typeof worldState.nextAuthorityOrder;
        break;
      }
      case "nextPlayerOrdinal": {
        worldState.nextPlayerOrdinal = metadataDelta.value as typeof worldState.nextPlayerOrdinal;
        break;
      }
      case "nextObjectOrdinal": {
        worldState.nextObjectOrdinal = metadataDelta.value as typeof worldState.nextObjectOrdinal;
        break;
      }
      case "commandLedger": {
        const ledgerValue = metadataDelta.value as { kind?: string; actorHighWater?: Record<string, number>; appendedReceipts?: Array<unknown>; trimmedCount?: number };
        if (ledgerValue.kind === "incremental") {
          const ledger = worldState.commandLedger;
          for (const [actorId, actorSequence] of Object.entries(ledgerValue.actorHighWater ?? {})) {
            ledger.actorHighWater[actorId] = actorSequence;
          }
          if ((ledgerValue.trimmedCount ?? 0) > 0) {
            ledger.recent.splice(0, Math.min(ledgerValue.trimmedCount ?? 0, ledger.recent.length));
          }
          for (const receipt of ledgerValue.appendedReceipts ?? []) {
            ledger.recent.push(receipt as typeof ledger.recent[number]);
          }
          if (ledger.recent.length > 256) {
            ledger.recent.splice(0, ledger.recent.length - 256);
          }
          break;
        }
        worldState.commandLedger = ledgerValue as typeof worldState.commandLedger;
        break;
      }
      default: {
        throw new TypeError("unsupported worldDelta metadata field");
      }
    }
  }
  worldState.worldRevision = delta.targetRevision;
}

function applyMetadataDelta(worldState: WorldStateDto, delta: WorldMetadataDelta): void {
  switch (delta.field) {
    case "roomId": {
      worldState.roomId = validateRoomId(delta.value, "worldDelta.metadata[].value");
      return;
    }
    case "tick": {
      worldState.tick = assertInteger(delta.value, "worldDelta.metadata[].value", 0, MAX_SAFE_INTEGER);
      return;
    }
    case "paused": {
      worldState.paused = assertBoolean(delta.value, "worldDelta.metadata[].value");
      return;
    }
    case "time": {
      const obj = assertObject(delta.value, "worldDelta.metadata[].value");
      const dayNightTick = assertInteger(requireField(obj, "dayNightTick", "worldDelta.metadata[].value.dayNightTick"), "worldDelta.metadata[].value.dayNightTick", 0, DAY_NIGHT_CYCLE_TICKS - 1);
      worldState.time = { dayNightTick };
      return;
    }
    case "weather": {
      worldState.weather = validateWeatherStateDto(delta.value);
      return;
    }
    case "random": {
      const randomState = validateGameplayRandomStateDto(delta.value);
      worldState.random = {
        algorithm: randomState.algorithm,
        seed: randomState.seed,
        state: randomState.state,
      };
      return;
    }
    case "ownerPlayerId": {
      worldState.ownerPlayerId = delta.value === null ? null : validatePlayerId(delta.value, "worldDelta.metadata[].value");
      return;
    }
    case "worldRevision": {
      worldState.worldRevision = assertInteger(delta.value, "worldDelta.metadata[].value", 0, MAX_SAFE_INTEGER);
      return;
    }
    case "nextAuthorityOrder": {
      worldState.nextAuthorityOrder = assertInteger(delta.value, "worldDelta.metadata[].value", 1, MAX_SAFE_INTEGER);
      return;
    }
    case "nextPlayerOrdinal": {
      worldState.nextPlayerOrdinal = assertInteger(delta.value, "worldDelta.metadata[].value", 1, MAX_SAFE_INTEGER);
      return;
    }
    case "nextObjectOrdinal": {
      worldState.nextObjectOrdinal = assertInteger(delta.value, "worldDelta.metadata[].value", 1, MAX_SAFE_INTEGER);
      return;
    }
    case "commandLedger": {
      const ledgerValue = validateCommandLedgerMetadataValue(delta.value);
      if ("kind" in ledgerValue && ledgerValue["kind"] === "incremental") {
        const ledger = worldState.commandLedger;
        for (const [actorId, actorSequence] of Object.entries(ledgerValue.actorHighWater)) {
          ledger.actorHighWater[actorId] = actorSequence;
        }
        if (ledgerValue.trimmedCount > 0) {
          ledger.recent.splice(0, Math.min(ledgerValue.trimmedCount, ledger.recent.length));
        }
        for (const receipt of ledgerValue.appendedReceipts) {
          ledger.recent.push(receipt);
        }
        if (ledger.recent.length > 256) {
          ledger.recent.splice(0, ledger.recent.length - 256);
        }
        return;
      }
      worldState.commandLedger = ledgerValue as CommandLedgerDto;
      return;
    }
    default: {
      throw new TypeError("unsupported worldDelta metadata field");
    }
  }
}

function validateWorldStateSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  if (snapshot.version !== WORLD_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError("snapshot.version is unsupported");
  }
  if (snapshot.worldState.schemaVersion !== WORLD_STATE_SCHEMA_VERSION) {
    throw new TypeError("snapshot.worldState.schemaVersion is unsupported");
  }
  const normalizedWorldState = canonicalizeWorldStateDto(snapshot.worldState);
  const expectedChecksum = computeWorldChecksum(normalizedWorldState);
  if (snapshot.checksum !== expectedChecksum) {
    throw new TypeError("snapshot.checksum does not match the canonical world state");
  }
  if (snapshot.worldRevision !== normalizedWorldState.worldRevision) {
    throw new TypeError("snapshot.worldRevision does not match the canonical world state revision");
  }
  return {
    version: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldRevision: normalizedWorldState.worldRevision,
    checksum: expectedChecksum,
    worldState: normalizedWorldState,
  };
}

export function computeWorldChecksum(candidate: WorldState | WorldSnapshot | WorldStateDto): string {
  let worldState: WorldStateDto;
  if (candidate && typeof candidate === "object" && (candidate as WorldSnapshot).version !== undefined && (candidate as WorldSnapshot).worldState !== undefined) {
    worldState = (candidate as WorldSnapshot).worldState;
  } else if (candidate && typeof candidate === "object" && (candidate as WorldState).grid instanceof Grid) {
    worldState = serializeWorldState(candidate as WorldState);
  } else {
    worldState = candidate as WorldStateDto;
  }
  return fnv1aHex(stableStringify(worldState));
}

export function createWorldSnapshot(world: WorldState): WorldSnapshot {
  const worldState = serializeWorldState(world);
  return {
    version: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldRevision: world.worldRevision,
    checksum: computeWorldChecksum(worldState),
    worldState,
  };
}

export function restoreWorldState(snapshot: WorldSnapshot): WorldState {
  const normalizedSnapshot = validateWorldStateSnapshot(snapshot);
  const restored = deserializeWorldState(normalizedSnapshot.worldState);
  restored.worldRevision = normalizedSnapshot.worldRevision;
  return restored;
}

export function decodeWorldDelta(value: unknown): WorldDelta {
  return validateWorldDelta(value);
}

export function applyWorldDeltaToSnapshot(snapshot: WorldSnapshot, delta: WorldDelta): WorldSnapshot {
  const normalizedSnapshot = validateWorldStateSnapshot(snapshot);
  const normalizedDelta = decodeWorldDelta(delta);
  if (normalizedSnapshot.worldRevision !== normalizedDelta.baseRevision) {
    throw new TypeError("worldDelta.baseRevision does not match the checkpoint revision");
  }
  if (normalizedDelta.gridDimensions !== undefined) {
    const grid = normalizedSnapshot.worldState.grid;
    if (grid.width !== normalizedDelta.gridDimensions.width || grid.height !== normalizedDelta.gridDimensions.height) {
      throw new TypeError("worldDelta.gridDimensions does not match the checkpoint dimensions");
    }
  }
  const nextWorldState = clonePlainObject(normalizedSnapshot.worldState);
  applyWorldDeltaToSnapshotStateInPlace(nextWorldState, normalizedDelta);
  const canonicalWorldState = canonicalizeWorldStateDto(nextWorldState);
  const nextWorldStateSnapshot: WorldSnapshot = {
    version: normalizedSnapshot.version,
    worldRevision: canonicalWorldState.worldRevision,
    checksum: computeWorldChecksum(canonicalWorldState),
    worldState: canonicalWorldState,
  };
  return nextWorldStateSnapshot;
}

export function applyWorldDeltaStream(snapshot: WorldSnapshot, deltas: WorldDelta[]): WorldSnapshot {
  let current = validateWorldStateSnapshot(snapshot);
  for (const delta of deltas) {
    current = applyWorldDeltaToSnapshot(current, delta);
  }
  return current;
}

export function getWorldSnapshotMetrics(world: WorldState): WorldSnapshotMetrics {
  const snapshot = createWorldSnapshot(world);
  const encoder = new TextEncoder();
  return {
    checksum: snapshot.checksum,
    snapshotByteSize: encoder.encode(stableStringify(snapshot.worldState)).length,
    dirtyCellCount: world.grid.dirtyCells.size,
  };
}
