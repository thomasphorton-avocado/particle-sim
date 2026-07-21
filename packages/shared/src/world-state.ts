import { Grid } from "./grid.js";
import { createDefaultHotbar, createDefaultInventory, type HotbarItem, type InventoryCounts } from "./inventory.js";
import { createObjectId, createPlayerId, createRoomId, type ObjectId, type PlayerId, type RoomId } from "./ids.js";
import { MaterialId } from "./materials.js";
import { createGameplayRandomState, type GameplayRandomState } from "./random.js";

export interface WeatherState {
  kind: "clear" | "rain" | "storm";
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

export interface FallingObjectState {
  id: ObjectId;
  materialId: MaterialId;
  x: number;
  y: number;
  restY: number;
  vy: number;
  offsets: [number, number][];
}

export interface PlayerState {
  id: PlayerId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  grounded: boolean;
  facing: -1 | 1;
  airTime: number;
  airTicks: number;
  previousJumpHeld: boolean;
  swingElapsedTicks: number | null;
  faucetCooldownUntilTick: number;
  crouching: boolean;
  lookingUp: boolean;
  swimming: boolean;
  inventory: InventoryCounts;
  hotbar: HotbarItem[];
  activeHotbarSlot: number;
}

export interface WorldTimeState {
  dayNightCycle: number;
  dayNightTick: number;
}

export interface WorldState {
  roomId: RoomId;
  grid: Grid;
  random: GameplayRandomState;
  players: Record<string, PlayerState>;
  fallingObjects: Record<string, FallingObjectState>;
  paused: boolean;
  tick: number;
  time: WorldTimeState;
  weather: WeatherState;
  nextPlayerOrdinal: number;
  nextObjectOrdinal: number;
}

export function createDefaultWeatherState(): WeatherState {
  return {
    kind: "clear",
    episodeElapsed: 0,
    episodeDuration: 0,
    wind: 0,
    visualTime: 0,
    rainAccumulator: 0,
    lightningFlash: null,
    lightningCooldown: null,
    boltX: null,
    boltY: null,
    boltSeed: 0,
  };
}

export function createDefaultPlayerState(id: PlayerId): PlayerState {
  return {
    id,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    width: 3,
    height: 5,
    grounded: false,
    facing: 1,
    airTime: 0,
    airTicks: 0,
    previousJumpHeld: false,
    swingElapsedTicks: null,
    faucetCooldownUntilTick: 0,
    crouching: false,
    lookingUp: false,
    swimming: false,
    inventory: createDefaultInventory(),
    hotbar: createDefaultHotbar(),
    activeHotbarSlot: 0,
  };
}

export function createDefaultFallingObjectState(id: ObjectId, materialId: MaterialId, x: number, y: number, restY: number, vy: number, offsets: [number, number][]): FallingObjectState {
  return { id, materialId, x, y, restY, vy, offsets: offsets.map(([dx, dy]) => [dx, dy] as [number, number]) };
}

export function createDefaultWorldState(roomId: RoomId | string = "room_default", grid?: Grid): WorldState {
  const roomIdInput = typeof roomId === "string" ? roomId : String(roomId);
  const normalizedRoomId = roomIdInput.startsWith("room_") ? roomIdInput : `room_${roomIdInput}`;
  const resolvedRoomId = createRoomId(normalizedRoomId);
  const world: WorldState = {
    roomId: resolvedRoomId,
    grid: grid ?? new Grid(80, 80),
    random: createGameplayRandomState(0),
    players: {},
    fallingObjects: {},
    paused: false,
    tick: 0,
    time: { dayNightCycle: 0.5, dayNightTick: 9000 },
    weather: createDefaultWeatherState(),
    nextPlayerOrdinal: 1,
    nextObjectOrdinal: 1,
  };
  return world;
}

export function allocatePlayerId(world: WorldState): PlayerId {
  let ordinal = world.nextPlayerOrdinal;
  while (true) {
    const candidate = createPlayerId(`player_${ordinal}`);
    if (!Object.prototype.hasOwnProperty.call(world.players, candidate)) {
      world.nextPlayerOrdinal = ordinal + 1;
      return candidate;
    }
    ordinal += 1;
  }
}

export function allocateObjectId(world: WorldState): ObjectId {
  let ordinal = world.nextObjectOrdinal;
  while (true) {
    const candidate = createObjectId(`object_${ordinal}`);
    const inPlayers = Object.values(world.players).some((player) => String(player.id) === String(candidate));
    const inFalling = Object.prototype.hasOwnProperty.call(world.fallingObjects, candidate);
    const inGrid = world.grid.objectIds.some((id) => id === candidate);
    if (!inPlayers && !inFalling && !inGrid) {
      world.nextObjectOrdinal = ordinal + 1;
      return candidate;
    }
    ordinal += 1;
  }
}

export function getPlayerState(world: WorldState, playerId: PlayerId): PlayerState | undefined {
  return world.players[playerId];
}

export function getFallingObjectState(world: WorldState, objectId: ObjectId): FallingObjectState | undefined {
  return world.fallingObjects[objectId];
}
