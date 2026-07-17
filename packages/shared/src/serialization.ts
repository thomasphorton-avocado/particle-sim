import { Grid } from "./grid.js";
import { createDefaultInventory, type HotbarItem, type InventoryCounts } from "./inventory.js";
import { createObjectId, createPlayerId, createRoomId, parseObjectId } from "./ids.js";
import { MaterialId } from "./materials.js";
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

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
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
      const materialId = assertInteger(item["materialId"], `hotbar[${index}].materialId`, 0, 1000);
      if (!Number.isInteger(materialId)) {
        throw new TypeError(`hotbar[${index}].materialId must be an integer`);
      }
      const count = assertInteger(item["count"], `hotbar[${index}].count`, 0, 1000);
      return { kind: "material", materialId: materialId as MaterialId, count };
    }
    throw new TypeError(`hotbar[${index}] has unsupported kind`);
  });
}

function validateInventory(value: unknown): InventoryCounts {
  const obj = assertObject(value, "inventory");
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
  const id = createPlayerId(assertString(obj["id"], "player.id"));
  const player = createDefaultPlayerState(id);
  player.x = assertFiniteNumber(obj["x"], "player.x");
  player.y = assertFiniteNumber(obj["y"], "player.y");
  player.vx = assertFiniteNumber(obj["vx"], "player.vx");
  player.vy = assertFiniteNumber(obj["vy"], "player.vy");
  player.width = assertFiniteNumber(obj["width"], "player.width");
  player.height = assertFiniteNumber(obj["height"], "player.height");
  player.grounded = Boolean(obj["grounded"]);
  const facing = obj["facing"];
  if (facing !== -1 && facing !== 1) throw new TypeError("player.facing must be -1 or 1");
  player.facing = facing as -1 | 1;
  player.airTime = assertFiniteNumber(obj["airTime"], "player.airTime");
  player.crouching = Boolean(obj["crouching"]);
  player.lookingUp = Boolean(obj["lookingUp"]);
  player.swimming = Boolean(obj["swimming"]);
  player.inventory = validateInventory(obj["inventory"]);
  player.hotbar = validateHotbar(obj["hotbar"]);
  player.activeHotbarSlot = assertInteger(obj["activeHotbarSlot"], "player.activeHotbarSlot", 0, 9);
  return player;
}

function validateFallingObjectState(value: unknown): FallingObjectState {
  const obj = assertObject(value, "falling object");
  const id = createObjectId(assertString(obj["id"], "fallingObject.id"));
  const materialId = assertInteger(obj["materialId"], "fallingObject.materialId", 0, 1000) as MaterialId;
  const offsets = assertArray(obj["offsets"], "fallingObject.offsets").map((entry) => {
    const pair = assertArray(entry, "fallingObject.offsets[]");
    if (pair.length !== 2) throw new TypeError("fallingObject.offsets entries must be length 2");
    return [assertFiniteNumber(pair[0], "fallingObject.offsets[0]"), assertFiniteNumber(pair[1], "fallingObject.offsets[1]")] as [number, number];
  });
  return createDefaultFallingObjectState(
    id,
    materialId,
    assertFiniteNumber(obj["x"], "fallingObject.x"),
    assertFiniteNumber(obj["y"], "fallingObject.y"),
    assertFiniteNumber(obj["restY"], "fallingObject.restY"),
    assertFiniteNumber(obj["vy"], "fallingObject.vy"),
    offsets,
  );
}

function validateWeatherState(value: unknown): WeatherState {
  const obj = assertObject(value, "weather");
  const kind = obj["kind"];
  if (kind !== "clear" && kind !== "rain" && kind !== "storm") {
    throw new TypeError("weather.kind must be clear, rain, or storm");
  }
  const weather = createDefaultWeatherState();
  weather.kind = kind as WeatherState["kind"];
  weather.episodeElapsed = assertInteger(obj["episodeElapsed"], "weather.episodeElapsed", 0, 1000000);
  weather.episodeDuration = assertInteger(obj["episodeDuration"], "weather.episodeDuration", 0, 1000000);
  weather.wind = assertInteger(obj["wind"], "weather.wind", -100, 100);
  weather.visualTime = assertInteger(obj["visualTime"], "weather.visualTime", 0, 1000000);
  weather.rainAccumulator = assertInteger(obj["rainAccumulator"], "weather.rainAccumulator", 0, 1000000);
  weather.lightningFlash = typeof obj["lightningFlash"] === "number" ? assertInteger(obj["lightningFlash"], "weather.lightningFlash", 0, 1000000) : null;
  weather.lightningCooldown = typeof obj["lightningCooldown"] === "number" ? assertInteger(obj["lightningCooldown"], "weather.lightningCooldown", 0, 1000000) : null;
  weather.boltX = typeof obj["boltX"] === "number" ? assertInteger(obj["boltX"], "weather.boltX") : null;
  weather.boltY = typeof obj["boltY"] === "number" ? assertInteger(obj["boltY"], "weather.boltY") : null;
  weather.boltSeed = assertInteger(obj["boltSeed"], "weather.boltSeed", 0, 1000000);
  return weather;
}

function validateGrid(value: unknown): Grid {
  const obj = assertObject(value, "grid");
  const width = assertInteger(obj["width"], "grid.width", 1, 10000);
  const height = assertInteger(obj["height"], "grid.height", 1, 10000);
  const ids = assertArray(obj["ids"], "grid.ids");
  const shade = assertArray(obj["shade"], "grid.shade");
  const auxiliary = assertArray(obj["auxiliary"], "grid.auxiliary");
  const objectMembership = assertArray(obj["objectMembership"], "grid.objectMembership");
  if (ids.length !== width * height) throw new TypeError("grid.ids length mismatch");
  if (shade.length !== width * height) throw new TypeError("grid.shade length mismatch");
  if (auxiliary.length !== width * height) throw new TypeError("grid.auxiliary length mismatch");

  const grid = new Grid(width, height);
  for (let i = 0; i < ids.length; i++) {
    const materialId = assertInteger(ids[i], `grid.ids[${i}]`, 0, 1000) as MaterialId;
    const shadeValue = assertInteger(shade[i], `grid.shade[${i}]`, -1000, 1000);
    const auxValue = assertInteger(auxiliary[i], `grid.auxiliary[${i}]`, -128, 127);
    grid.ids[i] = materialId;
    grid.shade[i] = shadeValue;
    grid.auxiliary[i] = auxValue;
    grid.objectIds[i] = null;
  }
  for (const entry of objectMembership) {
    if (entry === null || typeof entry !== "object") throw new TypeError("grid.objectMembership entries must be objects");
    const item = entry as Record<string, unknown>;
    const x = assertInteger(item["x"], "grid.objectMembership.x", 0, width - 1);
    const y = assertInteger(item["y"], "grid.objectMembership.y", 0, height - 1);
    const objectId = parseObjectId(item["objectId"]);
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
    objectMembership.push({ x, y, objectId: objectId });
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
    inventory: player.inventory,
    hotbar: player.hotbar,
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
    offsets: objectState.offsets,
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

export function deserializeWorldState(input: unknown): WorldState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("world state payload must be an object");
  }
  const obj = input as Record<string, unknown>;
  const version = obj["schemaVersion"];
  if (version !== WORLD_STATE_SCHEMA_VERSION) {
    throw new TypeError("unsupported world state schema version");
  }
  const roomId = createRoomId(assertString(obj["roomId"], "roomId"));
  const world = createDefaultWorldState(roomId);
  world.grid = validateGrid(obj["grid"]);
  world.players = {};
  if (obj["players"] !== undefined) {
    const players = assertObject(obj["players"], "players");
    for (const [key, playerEntry] of Object.entries(players)) {
      const player = validatePlayerState(playerEntry);
      world.players[player.id] = player;
      if (key !== player.id) {
        throw new TypeError("player key mismatch");
      }
    }
  }
  world.fallingObjects = {};
  if (obj["fallingObjects"] !== undefined) {
    const fallingObjects = assertObject(obj["fallingObjects"], "fallingObjects");
    for (const [key, objectEntry] of Object.entries(fallingObjects)) {
      const objectState = validateFallingObjectState(objectEntry);
      world.fallingObjects[objectState.id] = objectState;
      if (key !== objectState.id) {
        throw new TypeError("falling object key mismatch");
      }
    }
  }
  world.paused = Boolean(obj["paused"]);
  const timeValue = obj["time"];
  const timeObj = typeof timeValue === "object" && timeValue !== null ? (timeValue as Record<string, unknown>) : undefined;
  world.time.dayNightCycle = assertFiniteNumber(timeObj ? timeObj["dayNightCycle"] : undefined, "time.dayNightCycle");
  world.weather = validateWeatherState(obj["weather"]);
  world.nextPlayerOrdinal = assertInteger(obj["nextPlayerOrdinal"], "nextPlayerOrdinal", 1, 1000000);
  world.nextObjectOrdinal = assertInteger(obj["nextObjectOrdinal"], "nextObjectOrdinal", 1, 1000000);
  return world;
}
