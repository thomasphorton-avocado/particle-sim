import { Grid, assertAuxiliaryValueForMaterial } from "./grid.js";
import { cloneHotbar, cloneInventory, createDefaultInventory, type HotbarItem, type InventoryCounts } from "./inventory.js";
import { parseObjectId, parsePlayerId, parseRoomId } from "./ids.js";
import { MATERIALS, MaterialId } from "./materials.js";
import { createDefaultFallingObjectState, createDefaultPlayerState, createDefaultWeatherState, createDefaultWorldState, type FallingObjectState, type PlayerState, type WeatherState, type WorldState } from "./world-state.js";

export const WORLD_STATE_SCHEMA_VERSION = 1;

export interface GridDto {
  width: number;
  height: number;
  ids: number[];
  shade: number[];
  auxiliary: number[];
  objectMembership: Array<{ x: number; y: number; objectId: string }>;
}

export interface PlayerStateDto {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  grounded: boolean;
  facing: -1 | 1;
  airTime: number;
  crouching: boolean;
  lookingUp: boolean;
  swimming: boolean;
  inventory: InventoryCounts;
  hotbar: HotbarItem[];
  activeHotbarSlot: number;
}

export interface FallingObjectStateDto {
  id: string;
  materialId: number;
  x: number;
  y: number;
  restY: number;
  vy: number;
  offsets: [number, number][];
}

export interface WeatherStateDto {
  kind: WeatherState["kind"];
  episodeElapsed: number;
  episodeDuration: number;
  wind: number;
  visualTime: number;
  rainAccumulator: number;
  lightningFlash: number | null;
  lightningCooldown: number | null;
  boltX: number | null;
  boltY: number | null;
  boltSeed: number;
}

export interface WorldStateDto {
  schemaVersion: 1;
  roomId: string;
  grid: GridDto;
  players: Record<string, PlayerStateDto>;
  fallingObjects: Record<string, FallingObjectStateDto>;
  paused: boolean;
  time: { dayNightCycle: number };
  weather: WeatherStateDto;
  nextPlayerOrdinal: number;
  nextObjectOrdinal: number;
}

const MAX_GRID_CELLS = 1_000_000;

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function assertInteger(value: unknown, label: string, min?: number, max?: number): number {
  const num = assertFiniteNumber(value, label);
  if (!Number.isInteger(num)) {
    throw new TypeError(`${label} must be an integer`);
  }
  if (min !== undefined && num < min) {
    throw new TypeError(`${label} must be >= ${min}`);
  }
  if (max !== undefined && num > max) {
    throw new TypeError(`${label} must be <= ${max}`);
  }
  return num;
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

function requireField<T>(obj: Record<string, unknown>, key: string, label: string): T {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    throw new TypeError(`${label} is required`);
  }
  return obj[key] as T;
}

function assertMaterialId(value: unknown, label: string): MaterialId {
  const materialId = assertInteger(value, label, 0, 255) as MaterialId;
  if (!Object.prototype.hasOwnProperty.call(MATERIALS, materialId)) {
    throw new TypeError(`${label} must reference a known material`);
  }
  return materialId;
}

function assertAuxiliaryValueForMaterialId(materialId: MaterialId, value: unknown, label: string): number {
  const auxValue = assertInteger(value, label, -128, 127);
  return assertAuxiliaryValueForMaterial(materialId, auxValue);
}

function validateHotbar(value: unknown): HotbarItem[] {
  const arr = assertArray(value, "hotbar");
  if (arr.length !== 10) {
    throw new TypeError("hotbar must contain exactly 10 slots");
  }
  return arr.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new TypeError(`hotbar[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const kind = item["kind"];
    if (kind === "empty") return { kind: "empty" };
    if (kind === "pickaxe") return { kind: "pickaxe" };
    if (kind === "material") {
      const materialId = assertMaterialId(item["materialId"], `hotbar[${index}].materialId`);
      const count = assertInteger(item["count"], `hotbar[${index}].count`, 0, 1000);
      return { kind: "material", materialId, count };
    }
    throw new TypeError(`hotbar[${index}] has unsupported kind`);
  });
}

function validateInventory(value: unknown): InventoryCounts {
  const obj = assertObject(value, "inventory");
  if (!Object.prototype.hasOwnProperty.call(obj, "flowers")) {
    throw new TypeError("inventory.flowers is required");
  }
  const normalized: InventoryCounts = createDefaultInventory();
  for (const [key, entry] of Object.entries(obj)) {
    if (key === "flowers") {
      normalized.flowers = assertInteger(entry, "inventory.flowers", 0, 1000000);
      continue;
    }
    normalized[key] = assertInteger(entry, `inventory.${key}`, 0, 1000000);
  }
  return normalized;
}

function validatePlayerState(value: unknown): PlayerState {
  const obj = assertObject(value, "player");
  const id = parsePlayerId(requireField(obj, "id", "player.id"));
  const player = createDefaultPlayerState(id);
  player.x = assertFiniteNumber(requireField(obj, "x", "player.x"), "player.x");
  player.y = assertFiniteNumber(requireField(obj, "y", "player.y"), "player.y");
  player.vx = assertFiniteNumber(requireField(obj, "vx", "player.vx"), "player.vx");
  player.vy = assertFiniteNumber(requireField(obj, "vy", "player.vy"), "player.vy");
  player.width = assertFiniteNumber(requireField(obj, "width", "player.width"), "player.width");
  player.height = assertFiniteNumber(requireField(obj, "height", "player.height"), "player.height");
  player.grounded = assertBoolean(requireField(obj, "grounded", "player.grounded"), "player.grounded");
  const facing = requireField(obj, "facing", "player.facing");
  if (facing !== -1 && facing !== 1) throw new TypeError("player.facing must be -1 or 1");
  player.facing = facing as -1 | 1;
  player.airTime = assertFiniteNumber(requireField(obj, "airTime", "player.airTime"), "player.airTime");
  player.crouching = assertBoolean(requireField(obj, "crouching", "player.crouching"), "player.crouching");
  player.lookingUp = assertBoolean(requireField(obj, "lookingUp", "player.lookingUp"), "player.lookingUp");
  player.swimming = assertBoolean(requireField(obj, "swimming", "player.swimming"), "player.swimming");
  player.inventory = validateInventory(requireField(obj, "inventory", "player.inventory"));
  player.hotbar = validateHotbar(requireField(obj, "hotbar", "player.hotbar"));
  player.activeHotbarSlot = assertInteger(requireField(obj, "activeHotbarSlot", "player.activeHotbarSlot"), "player.activeHotbarSlot", 0, 9);
  return player;
}

function validateFallingObjectState(value: unknown): FallingObjectState {
  const obj = assertObject(value, "falling object");
  const id = parseObjectId(requireField(obj, "id", "fallingObject.id"));
  const materialId = assertMaterialId(requireField(obj, "materialId", "fallingObject.materialId"), "fallingObject.materialId");
  if (MATERIALS[materialId].placement.kind !== "object") {
    throw new TypeError("fallingObject.materialId must reference an object material");
  }
  const offsets = assertArray(requireField(obj, "offsets", "fallingObject.offsets"), "fallingObject.offsets").map((entry) => {
    const pair = assertArray(entry, "fallingObject.offsets[]");
    if (pair.length !== 2) throw new TypeError("fallingObject.offsets entries must be length 2");
    return [assertInteger(pair[0], "fallingObject.offsets[0]"), assertInteger(pair[1], "fallingObject.offsets[1]")] as [number, number];
  });
  return createDefaultFallingObjectState(
    id,
    materialId,
    assertInteger(requireField(obj, "x", "fallingObject.x"), "fallingObject.x"),
    assertFiniteNumber(requireField(obj, "y", "fallingObject.y"), "fallingObject.y"),
    assertInteger(requireField(obj, "restY", "fallingObject.restY"), "fallingObject.restY"),
    assertFiniteNumber(requireField(obj, "vy", "fallingObject.vy"), "fallingObject.vy"),
    offsets,
  );
}

function validateWeatherState(value: unknown): WeatherState {
  const obj = assertObject(value, "weather");
  const kind = requireField(obj, "kind", "weather.kind");
  if (kind !== "clear" && kind !== "rain" && kind !== "storm") {
    throw new TypeError("weather.kind must be clear, rain, or storm");
  }
  const weather = createDefaultWeatherState();
  weather.kind = kind as WeatherState["kind"];
  weather.episodeElapsed = assertFiniteNumber(requireField(obj, "episodeElapsed", "weather.episodeElapsed"), "weather.episodeElapsed");
  weather.episodeDuration = assertFiniteNumber(requireField(obj, "episodeDuration", "weather.episodeDuration"), "weather.episodeDuration");
  weather.wind = assertFiniteNumber(requireField(obj, "wind", "weather.wind"), "weather.wind");
  weather.visualTime = assertFiniteNumber(requireField(obj, "visualTime", "weather.visualTime"), "weather.visualTime");
  weather.rainAccumulator = assertFiniteNumber(requireField(obj, "rainAccumulator", "weather.rainAccumulator"), "weather.rainAccumulator");
  weather.lightningFlash = requireField(obj, "lightningFlash", "weather.lightningFlash") === null ? null : assertFiniteNumber(requireField(obj, "lightningFlash", "weather.lightningFlash"), "weather.lightningFlash");
  weather.lightningCooldown = requireField(obj, "lightningCooldown", "weather.lightningCooldown") === null ? null : assertFiniteNumber(requireField(obj, "lightningCooldown", "weather.lightningCooldown"), "weather.lightningCooldown");
  weather.boltX = requireField(obj, "boltX", "weather.boltX") === null ? null : assertFiniteNumber(requireField(obj, "boltX", "weather.boltX"), "weather.boltX");
  weather.boltY = requireField(obj, "boltY", "weather.boltY") === null ? null : assertFiniteNumber(requireField(obj, "boltY", "weather.boltY"), "weather.boltY");
  weather.boltSeed = assertFiniteNumber(requireField(obj, "boltSeed", "weather.boltSeed"), "weather.boltSeed");
  return weather;
}

function validateGrid(value: unknown): Grid {
  const obj = assertObject(value, "grid");
  const width = assertInteger(requireField(obj, "width", "grid.width"), "grid.width", 1, 10000);
  const height = assertInteger(requireField(obj, "height", "grid.height"), "grid.height", 1, 10000);
  const totalCells = width * height;
  if (totalCells > MAX_GRID_CELLS) {
    throw new TypeError("grid dimensions exceed the maximum allowed cell count");
  }
  const ids = assertArray(requireField(obj, "ids", "grid.ids"), "grid.ids");
  const shade = assertArray(requireField(obj, "shade", "grid.shade"), "grid.shade");
  const auxiliary = assertArray(requireField(obj, "auxiliary", "grid.auxiliary"), "grid.auxiliary");
  const objectMembership = assertArray(requireField(obj, "objectMembership", "grid.objectMembership"), "grid.objectMembership");
  if (ids.length !== totalCells) throw new TypeError("grid.ids length mismatch");
  if (shade.length !== totalCells) throw new TypeError("grid.shade length mismatch");
  if (auxiliary.length !== totalCells) throw new TypeError("grid.auxiliary length mismatch");

  const grid = new Grid(width, height);
  for (let i = 0; i < ids.length; i++) {
    const materialId = assertMaterialId(ids[i], `grid.ids[${i}]`);
    const shadeValue = assertInteger(shade[i], `grid.shade[${i}]`, -128, 127);
    const auxValue = assertInteger(auxiliary[i], `grid.auxiliary[${i}]`, -128, 127);
    grid.ids[i] = materialId;
    grid.shade[i] = shadeValue;
    grid.auxiliary[i] = assertAuxiliaryValueForMaterialId(materialId, auxValue, `grid.auxiliary[${i}]`);
    grid.objectIds[i] = null;
  }
  const seenCoordinates = new Set<string>();
  const materialByObjectId = new Map<string, MaterialId>();
  for (const entry of objectMembership) {
    if (entry === null || typeof entry !== "object") throw new TypeError("grid.objectMembership entries must be objects");
    const item = entry as Record<string, unknown>;
    const x = assertInteger(requireField(item, "x", "grid.objectMembership.x"), "grid.objectMembership.x", 0, width - 1);
    const y = assertInteger(requireField(item, "y", "grid.objectMembership.y"), "grid.objectMembership.y", 0, height - 1);
    const key = `${x},${y}`;
    if (seenCoordinates.has(key)) throw new TypeError("grid.objectMembership contains duplicate coordinates");
    seenCoordinates.add(key);
    const objectId = parseObjectId(requireField(item, "objectId", "grid.objectMembership.objectId"));
    const materialId = grid.get(x, y);
    if (materialId === MaterialId.Empty) throw new TypeError("grid.objectMembership must target a non-empty cell");
    if (MATERIALS[materialId].placement.kind !== "object") throw new TypeError("grid.objectMembership must target an object-material cell");
    const previousMaterial = materialByObjectId.get(objectId);
    if (previousMaterial !== undefined && previousMaterial !== materialId) {
      throw new TypeError("grid.objectMembership contains inconsistent materials for the same object ID");
    }
    materialByObjectId.set(objectId, materialId);
    grid.setObjectCell(x, y, objectId);
  }
  return grid;
}

export function serializeWorldState(world: WorldState): WorldStateDto {
  const grid = world.grid;
  const objectMembership: Array<{ x: number; y: number; objectId: string }> = [];
  for (let i = 0; i < grid.objectIds.length; i++) {
    const objectId = grid.objectIds[i];
    if (!objectId) continue;
    const x = i % grid.width;
    const y = Math.floor(i / grid.width);
    objectMembership.push({ x, y, objectId });
  }

  return {
    schemaVersion: WORLD_STATE_SCHEMA_VERSION,
    roomId: world.roomId,
    grid: {
      width: grid.width,
      height: grid.height,
      ids: Array.from(grid.ids),
      shade: Array.from(grid.shade),
      auxiliary: Array.from(grid.auxiliary),
      objectMembership,
    },
    players: Object.fromEntries(Object.entries(world.players).map(([key, value]) => [key, serializePlayerState(value)])),
    fallingObjects: Object.fromEntries(Object.entries(world.fallingObjects).map(([key, value]) => [key, serializeFallingObjectState(value)])),
    paused: world.paused,
    time: { dayNightCycle: world.time.dayNightCycle },
    weather: serializeWeatherState(world.weather),
    nextPlayerOrdinal: world.nextPlayerOrdinal,
    nextObjectOrdinal: world.nextObjectOrdinal,
  };
}

export function serializePlayerState(player: PlayerState): PlayerStateDto {
  return {
    id: player.id,
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    width: player.width,
    height: player.height,
    grounded: player.grounded,
    facing: player.facing,
    airTime: player.airTime,
    crouching: player.crouching,
    lookingUp: player.lookingUp,
    swimming: player.swimming,
    inventory: cloneInventory(player.inventory),
    hotbar: cloneHotbar(player.hotbar),
    activeHotbarSlot: player.activeHotbarSlot,
  };
}

export function serializeFallingObjectState(objectState: FallingObjectState): FallingObjectStateDto {
  return {
    id: objectState.id,
    materialId: objectState.materialId,
    x: objectState.x,
    y: objectState.y,
    restY: objectState.restY,
    vy: objectState.vy,
    offsets: objectState.offsets.map(([dx, dy]) => [dx, dy] as [number, number]),
  };
}

export function serializeWeatherState(weather: WeatherState): WeatherStateDto {
  return {
    kind: weather.kind,
    episodeElapsed: weather.episodeElapsed,
    episodeDuration: weather.episodeDuration,
    wind: weather.wind,
    visualTime: weather.visualTime,
    rainAccumulator: weather.rainAccumulator,
    lightningFlash: weather.lightningFlash,
    lightningCooldown: weather.lightningCooldown,
    boltX: weather.boltX,
    boltY: weather.boltY,
    boltSeed: weather.boltSeed,
  };
}

function validateObjectIdentityInvariants(world: WorldState): void {
  const fallingIds = new Set<string>();
  for (const objectState of Object.values(world.fallingObjects)) {
    if (fallingIds.has(objectState.id)) {
      throw new TypeError("falling object IDs must be unique");
    }
    fallingIds.add(objectState.id);
  }
  for (let i = 0; i < world.grid.objectIds.length; i++) {
    const objectId = world.grid.objectIds[i];
    if (!objectId) continue;
    if (fallingIds.has(objectId)) {
      throw new TypeError("falling and placed object IDs must be disjoint");
    }
  }
}

export function deserializeWorldState(input: unknown): WorldState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("world state payload must be an object");
  }
  const obj = input as Record<string, unknown>;
  for (const key of ["schemaVersion", "roomId", "grid", "players", "fallingObjects", "paused", "time", "weather", "nextPlayerOrdinal", "nextObjectOrdinal"]) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new TypeError(`${key} is required`);
    }
  }
  const version = requireField(obj, "schemaVersion", "schemaVersion");
  if (version !== WORLD_STATE_SCHEMA_VERSION) {
    throw new TypeError("unsupported world state schema version");
  }
  const roomId = parseRoomId(requireField(obj, "roomId", "roomId"));
  const world = createDefaultWorldState(roomId);
  world.grid = validateGrid(requireField(obj, "grid", "grid"));
  world.players = {};
  const players = assertObject(requireField(obj, "players", "players"), "players");
  for (const [key, playerEntry] of Object.entries(players)) {
    const player = validatePlayerState(playerEntry);
    world.players[player.id] = player;
    if (key !== player.id) {
      throw new TypeError("player key mismatch");
    }
  }
  world.fallingObjects = {};
  const fallingObjects = assertObject(requireField(obj, "fallingObjects", "fallingObjects"), "fallingObjects");
  for (const [key, objectEntry] of Object.entries(fallingObjects)) {
    const objectState = validateFallingObjectState(objectEntry);
    world.fallingObjects[objectState.id] = objectState;
    if (key !== objectState.id) {
      throw new TypeError("falling object key mismatch");
    }
  }
  world.paused = assertBoolean(requireField(obj, "paused", "paused"), "paused");
  const timeValue = requireField(obj, "time", "time");
  const timeObj = typeof timeValue === "object" && timeValue !== null ? (timeValue as Record<string, unknown>) : undefined;
  if (!timeObj || !Object.prototype.hasOwnProperty.call(timeObj, "dayNightCycle")) {
    throw new TypeError("time.dayNightCycle is required");
  }
  world.time.dayNightCycle = assertFiniteNumber(timeObj["dayNightCycle"], "time.dayNightCycle");
  world.weather = validateWeatherState(requireField(obj, "weather", "weather"));
  world.nextPlayerOrdinal = assertInteger(requireField(obj, "nextPlayerOrdinal", "nextPlayerOrdinal"), "nextPlayerOrdinal", 1, 1000000);
  world.nextObjectOrdinal = assertInteger(requireField(obj, "nextObjectOrdinal", "nextObjectOrdinal"), "nextObjectOrdinal", 1, 1000000);
  validateObjectIdentityInvariants(world);
  return world;
}
