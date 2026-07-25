import { assertAuxiliaryValueForMaterial, Grid } from "./grid.js";
import { parseObjectId, parsePlayerId, parseRoomId } from "./ids.js";
import { MaterialId, MATERIALS } from "./materials.js";
import { DAY_NIGHT_CYCLE_TICKS } from "./gameplay.js";
import { deserializeWorldState, serializeWorldState, WORLD_STATE_SCHEMA_VERSION, type WorldStateDto, type PlayerStateDto, type FallingObjectStateDto, type WeatherStateDto, type CommandLedgerDto } from "./serialization.js";
import { type WorldState, type WeatherState } from "./world-state.js";
import { createGameplayRandomState, type GameplayRandomState } from "./random.js";

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
  state: PlayerStateDto;
}

export interface WorldFallingObjectDelta {
  objectId: string;
  state: FallingObjectStateDto;
}

export interface WorldMetadataDelta {
  field: "roomId" | "tick" | "paused" | "time" | "weather" | "random" | "ownerPlayerId" | "worldRevision" | "nextAuthorityOrder" | "nextPlayerOrdinal" | "nextObjectOrdinal" | "commandLedger";
  value: unknown;
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

function clonePlainObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  const inventory = assertObject(requireField(obj, "inventory", "playerDelta.state.inventory"), "playerDelta.state.inventory");
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
  const input = assertObject(requireField(obj, "input", "playerDelta.state.input"), "playerDelta.state.input");
  assertBoolean(input["left"], "playerDelta.state.input.left");
  assertBoolean(input["right"], "playerDelta.state.input.right");
  assertBoolean(input["jumpHeld"], "playerDelta.state.input.jumpHeld");
  assertBoolean(input["crouchHeld"], "playerDelta.state.input.crouchHeld");
  assertBoolean(input["lookUpHeld"], "playerDelta.state.input.lookUpHeld");
  assertBoolean(input["mineHeld"], "playerDelta.state.input.mineHeld");
  const pendingRefunds = assertObject(requireField(obj, "pendingRefunds", "playerDelta.state.pendingRefunds"), "playerDelta.state.pendingRefunds");
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
    hotbar: hotbarValues.map((entry) => entry as PlayerStateDto["hotbar"][number]),
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
    offsets: normalizedOffsets,
    provenance: requireField(obj, "provenance", "fallingObjectDelta.state.provenance") as FallingObjectStateDto["provenance"],
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
  const actorHighWater = assertObject(requireField(obj, "actorHighWater", "commandLedgerDelta.state.actorHighWater"), "commandLedgerDelta.state.actorHighWater");
  const recent = assertArray(requireField(obj, "recent", "commandLedgerDelta.state.recent"), "commandLedgerDelta.state.recent");
  const normalized: CommandLedgerDto = { actorHighWater: {}, recent: [] };
  for (const [key, entry] of Object.entries(actorHighWater)) {
    normalized.actorHighWater[key] = assertInteger(entry, `commandLedgerDelta.state.actorHighWater.${key}`, 0, MAX_SAFE_INTEGER);
  }
  for (const item of recent) {
    const receipt = assertObject(item, "commandLedgerDelta.state.recent[]");
    normalized.recent.push(receipt as unknown as CommandLedgerDto["recent"][number]);
  }
  return normalized;
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
  return { field: field as WorldMetadataDelta["field"], value };
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
  const cells = (requireField(obj, "cells", "worldDelta.cells") as unknown[]).map((entry) => validateCellDelta(entry));
  const players = (requireField(obj, "players", "worldDelta.players") as unknown[]).map((entry) => {
    const playerObj = assertObject(entry, "worldDelta.players[]");
    const playerId = validatePlayerId(requireField(playerObj, "playerId", "worldDelta.players[].playerId"), "worldDelta.players[].playerId");
    const state = validatePlayerStateDto(requireField(playerObj, "state", "worldDelta.players[].state"));
    if (playerId !== state.id) {
      throw new TypeError("worldDelta.players[].playerId must match playerDelta.state.id");
    }
    return { playerId, state };
  });
  const fallingObjects = (requireField(obj, "fallingObjects", "worldDelta.fallingObjects") as unknown[]).map((entry) => {
    const objectObj = assertObject(entry, "worldDelta.fallingObjects[]");
    const objectId = validateObjectId(requireField(objectObj, "objectId", "worldDelta.fallingObjects[].objectId"), "worldDelta.fallingObjects[].objectId");
    const state = validateFallingObjectStateDto(requireField(objectObj, "state", "worldDelta.fallingObjects[].state"));
    if (objectId !== state.id) {
      throw new TypeError("worldDelta.fallingObjects[].objectId must match fallingObjectDelta.state.id");
    }
    return { objectId, state };
  });
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
      worldState.commandLedger = validateCommandLedgerDto(delta.value);
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
  const grid = nextWorldState.grid;
  const totalCells = grid.width * grid.height;
  for (const cellDelta of normalizedDelta.cells) {
    if (cellDelta.index < 0 || cellDelta.index >= totalCells) {
      throw new TypeError("worldDelta cell index is out of bounds");
    }
    const currentRevision = grid.cellRevisions[cellDelta.index] ?? 0;
    if (cellDelta.revision <= currentRevision) {
      throw new TypeError("worldDelta cell revision is stale");
    }
  }
  for (const cellDelta of normalizedDelta.cells) {
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
  for (const playerDelta of normalizedDelta.players) {
    nextWorldState.players[playerDelta.playerId] = playerDelta.state;
  }
  for (const fallingObjectDelta of normalizedDelta.fallingObjects) {
    nextWorldState.fallingObjects[fallingObjectDelta.objectId] = fallingObjectDelta.state;
  }
  for (const metadataDelta of normalizedDelta.metadata) {
    applyMetadataDelta(nextWorldState, metadataDelta);
  }
  nextWorldState.worldRevision = normalizedDelta.targetRevision;
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
