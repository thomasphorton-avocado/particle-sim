import { Grid, assertAuxiliaryValueForMaterial } from "./grid.js";
import { cloneHotbar, createDefaultInventory, type HotbarItem, type InventoryCounts } from "./inventory.js";
import { parseCommandId, parseObjectId, parsePlayerId, parseRoomId } from "./ids.js";
import { MATERIALS, MaterialId } from "./materials.js";
import { createDefaultFallingObjectState, createDefaultPlayerState, createDefaultWeatherState, createDefaultWorldState, type CommandLedgerState, type FallingObjectState, type FallingObjectProvenance, type PlayerState, type WeatherState, type WorldState } from "./world-state.js";
import { createGameplayRandomState, type GameplayRandomState } from "./random.js";
import { DAY_NIGHT_CYCLE_TICKS } from "./gameplay.js";
import type { CommandReceipt } from "./commands.js";

export const WORLD_STATE_SCHEMA_VERSION = 4;

export interface GameplayRandomStateDto {
  algorithm: "mulberry32-v1";
  seed: number;
  state: number;
}

export interface GridDto {
  width: number;
  height: number;
  ids: number[];
  shade: number[];
  auxiliary: number[];
  objectMembership: Array<{ x: number; y: number; objectId: string }>;
  cellRevisions: number[];
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
  airTicks: number;
  previousJumpHeld: boolean;
  swingElapsedTicks: number | null;
  faucetCooldownUntilTick: number;
  crouching: boolean;
  lookingUp: boolean;
  swimming: boolean;
  input: { left: boolean; right: boolean; jumpHeld: boolean; crouchHeld: boolean; lookUpHeld: boolean; mineHeld: boolean };
  inventory: InventoryCounts;
  hotbar: HotbarItem[];
  activeHotbarSlot: number;
  inventoryRevision: number;
  pendingRefunds: Record<string, number>;
}

export interface FallingObjectStateDto {
  id: string;
  materialId: number;
  x: number;
  y: number;
  restY: number;
  vy: number;
  offsets: [number, number][];
  provenance: FallingObjectProvenance;
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

export interface CommandLedgerDto {
  actorHighWater: Record<string, number>;
  recent: CommandReceipt[];
}

export interface WorldStateDto {
  schemaVersion: 4;
  roomId: string;
  grid: GridDto;
  random: GameplayRandomStateDto;
  players: Record<string, PlayerStateDto>;
  fallingObjects: Record<string, FallingObjectStateDto>;
  paused: boolean;
  tick: number;
  time: { dayNightTick: number };
  weather: WeatherStateDto;
  nextPlayerOrdinal: number;
  nextObjectOrdinal: number;
  ownerPlayerId: string | null;
  worldRevision: number;
  nextAuthorityOrder: number;
  commandLedger: CommandLedgerDto;
}

const MAX_GRID_CELLS = 1_000_000;
const MAX_SAFE_INTEGER = 0x1_0000_0000 - 1;
const DEFAULT_RANDOM_SEED = 0;
const VALID_COMMAND_TYPES = new Set(["set_input_state", "mine_start", "mine_stop", "select_slot", "place", "harvest", "cycle_faucet", "pause_world", "resume_world", "set_time_preset"]);
const VALID_COMMAND_RESULT_CODES = new Set(["accepted", "unknown_actor", "paused", "not_owner", "already_state", "future_tick", "stale", "conflict", "slot", "tool", "revision", "inventory", "target", "bounds", "range", "collision", "footprint", "work_limit", "invalid_command"]);
const COMMAND_RECEIPT_FIELDS = ["accepted", "acceptedEffect", "actorId", "actorSequence", "afterInventoryRevision", "afterTargetRevision", "afterWorldRevision", "authorityOrder", "beforeInventoryRevision", "beforeTargetRevision", "beforeWorldRevision", "code", "commandId", "commandType", "fingerprint", "issuedTick", "processedTick"];

function normalizeDayNightTick(dayNightCycle: number): number {
  return ((Math.round(dayNightCycle * DAY_NIGHT_CYCLE_TICKS) % DAY_NIGHT_CYCLE_TICKS) + DAY_NIGHT_CYCLE_TICKS) % DAY_NIGHT_CYCLE_TICKS;
}

function normalizeLegacyAirTicksSeconds(airTimeSeconds: number): number {
  const roundedTicks = Math.round(airTimeSeconds * 60);
  return Math.max(0, Math.min(MAX_SAFE_INTEGER, roundedTicks));
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

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertAllowedFields(value: Record<string, unknown>, allowedFields: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new TypeError(`${label} contains unknown field ${key}`);
    }
  }
}

function compareStringCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function validatePersistedInput(value: unknown): PlayerState["input"] {
  const obj = assertObject(value, "input");
  return {
    left: assertBoolean(requireField(obj, "left", "input.left"), "input.left"),
    right: assertBoolean(requireField(obj, "right", "input.right"), "input.right"),
    jumpHeld: assertBoolean(requireField(obj, "jumpHeld", "input.jumpHeld"), "input.jumpHeld"),
    crouchHeld: assertBoolean(requireField(obj, "crouchHeld", "input.crouchHeld"), "input.crouchHeld"),
    lookUpHeld: assertBoolean(requireField(obj, "lookUpHeld", "input.lookUpHeld"), "input.lookUpHeld"),
    mineHeld: assertBoolean(requireField(obj, "mineHeld", "input.mineHeld"), "input.mineHeld"),
  };
}

function validatePendingRefunds(value: unknown): Record<string, number> {
  const obj = assertObject(value, "pendingRefunds");
  const normalized: Record<string, number> = {};
  for (const [key, entry] of Object.entries(obj)) {
    normalized[key] = assertInteger(entry, `pendingRefunds.${key}`, 0, 1000000);
  }
  return normalized;
}

export function validateCommandReceipt(value: unknown, label = "commandReceipt"): CommandReceipt {
  const obj = assertObject(value, label);
  const allowedFields = new Set(COMMAND_RECEIPT_FIELDS);
  assertAllowedFields(obj, allowedFields, label);
  const commandId = parseCommandId(requireField(obj, "commandId", `${label}.commandId`));
  const actorId = parsePlayerId(requireField(obj, "actorId", `${label}.actorId`));
  const actorSequence = assertInteger(requireField(obj, "actorSequence", `${label}.actorSequence`), `${label}.actorSequence`, 0, MAX_SAFE_INTEGER);
  const authorityOrder = requireField(obj, "authorityOrder", `${label}.authorityOrder`) === null
    ? null
    : assertInteger(requireField(obj, "authorityOrder", `${label}.authorityOrder`), `${label}.authorityOrder`, 1, MAX_SAFE_INTEGER);
  const issuedTick = assertInteger(requireField(obj, "issuedTick", `${label}.issuedTick`), `${label}.issuedTick`, 0, MAX_SAFE_INTEGER);
  const processedTick = assertInteger(requireField(obj, "processedTick", `${label}.processedTick`), `${label}.processedTick`, 0, MAX_SAFE_INTEGER);
  const commandTypeValue = requireField(obj, "commandType", `${label}.commandType`) as CommandReceipt["commandType"];
  const codeValue = requireField(obj, "code", `${label}.code`) as CommandReceipt["code"];
  const accepted = assertBoolean(requireField(obj, "accepted", `${label}.accepted`), `${label}.accepted`);
  const beforeWorldRevision = assertInteger(requireField(obj, "beforeWorldRevision", `${label}.beforeWorldRevision`), `${label}.beforeWorldRevision`, 0, MAX_SAFE_INTEGER);
  const afterWorldRevision = assertInteger(requireField(obj, "afterWorldRevision", `${label}.afterWorldRevision`), `${label}.afterWorldRevision`, 0, MAX_SAFE_INTEGER);
  const beforeInventoryRevision = assertInteger(requireField(obj, "beforeInventoryRevision", `${label}.beforeInventoryRevision`), `${label}.beforeInventoryRevision`, 0, MAX_SAFE_INTEGER);
  const afterInventoryRevision = assertInteger(requireField(obj, "afterInventoryRevision", `${label}.afterInventoryRevision`), `${label}.afterInventoryRevision`, 0, MAX_SAFE_INTEGER);
  const beforeTargetRevision = assertInteger(requireField(obj, "beforeTargetRevision", `${label}.beforeTargetRevision`), `${label}.beforeTargetRevision`, 0, MAX_SAFE_INTEGER);
  const afterTargetRevision = assertInteger(requireField(obj, "afterTargetRevision", `${label}.afterTargetRevision`), `${label}.afterTargetRevision`, 0, MAX_SAFE_INTEGER);
  const acceptedEffectValue = requireField(obj, "acceptedEffect", `${label}.acceptedEffect`);
  const fingerprintValue = requireField(obj, "fingerprint", `${label}.fingerprint`);
  if (Object.keys(obj).length !== allowedFields.size) {
    throw new TypeError(`${label} must include exactly ${allowedFields.size} fields`);
  }
  const receipt: CommandReceipt = {
    commandId,
    actorId,
    actorSequence,
    authorityOrder,
    issuedTick,
    processedTick,
    commandType: commandTypeValue,
    code: codeValue,
    accepted,
    beforeWorldRevision,
    afterWorldRevision,
    beforeInventoryRevision,
    afterInventoryRevision,
    beforeTargetRevision,
    afterTargetRevision,
    acceptedEffect: null,
    fingerprint: "",
  };
  const commandType = assertString(receipt.commandType, `${label}.commandType`);
  if (!VALID_COMMAND_TYPES.has(commandType)) {
    throw new TypeError(`${label}.commandType must be a supported gameplay command type`);
  }
  const code = assertString(receipt.code, `${label}.code`);
  if (!VALID_COMMAND_RESULT_CODES.has(code)) {
    throw new TypeError(`${label}.code must be a supported command result code`);
  }
  if (receipt.accepted && code !== "accepted") {
    throw new TypeError(`${label}.accepted must be false when code is not accepted`);
  }
  if (!receipt.accepted && code === "accepted") {
    throw new TypeError(`${label}.accepted must be true when code is accepted`);
  }
  const acceptedEffect = acceptedEffectValue === null ? null : validateAcceptedEffect(acceptedEffectValue, `${label}.acceptedEffect`);
  const fingerprint = assertString(fingerprintValue, `${label}.fingerprint`);
  if (fingerprint.length > 1024) {
    throw new TypeError(`${label}.fingerprint must be at most 1024 characters`);
  }
  receipt.commandType = commandType as CommandReceipt["commandType"];
  receipt.code = code as CommandReceipt["code"];
  receipt.acceptedEffect = acceptedEffect;
  receipt.fingerprint = fingerprint;
  assertCommandResultInvariants({
    accepted: receipt.accepted,
    code: receipt.code,
    authorityOrder: receipt.authorityOrder,
    acceptedEffect: receipt.acceptedEffect,
    beforeWorldRevision: receipt.beforeWorldRevision,
    afterWorldRevision: receipt.afterWorldRevision,
    beforeInventoryRevision: receipt.beforeInventoryRevision,
    afterInventoryRevision: receipt.afterInventoryRevision,
    beforeTargetRevision: receipt.beforeTargetRevision,
    afterTargetRevision: receipt.afterTargetRevision,
  }, label);
  return receipt;
}

function validateAcceptedEffect(value: unknown, label: string): string | null {
  const effect = assertString(value, label);
  if (effect.length > 64) {
    throw new TypeError(`${label} must be at most 64 characters`);
  }
  return effect;
}

export function assertCommandResultInvariants(
  value: {
    accepted: boolean;
    code: string;
    authorityOrder: number | null;
    acceptedEffect: string | null;
    beforeWorldRevision: number;
    afterWorldRevision: number;
    beforeInventoryRevision: number;
    afterInventoryRevision: number;
    beforeTargetRevision: number;
    afterTargetRevision: number;
  },
  label = "commandReceipt",
): void {
  if (value.accepted && value.code !== "accepted") {
    throw new TypeError(`${label}.accepted must be false when code is not accepted`);
  }
  if (!value.accepted && value.code === "accepted") {
    throw new TypeError(`${label}.accepted must be true when code is accepted`);
  }
  if (value.accepted) {
    if (value.authorityOrder === null || value.authorityOrder < 1) {
      throw new TypeError(`${label}.authorityOrder must be a positive integer for accepted results`);
    }
    if (value.acceptedEffect === null) {
      throw new TypeError(`${label}.acceptedEffect is required for accepted results`);
    }
    if (value.afterWorldRevision < value.beforeWorldRevision) {
      throw new TypeError(`${label}.afterWorldRevision cannot be less than beforeWorldRevision for accepted results`);
    }
    if (value.afterInventoryRevision < value.beforeInventoryRevision) {
      throw new TypeError(`${label}.afterInventoryRevision cannot be less than beforeInventoryRevision for accepted results`);
    }
    if (value.afterTargetRevision < value.beforeTargetRevision) {
      throw new TypeError(`${label}.afterTargetRevision cannot be less than beforeTargetRevision for accepted results`);
    }
    return;
  }
  if (value.authorityOrder !== null) {
    throw new TypeError(`${label}.authorityOrder must be null for rejected results`);
  }
  if (value.acceptedEffect !== null) {
    throw new TypeError(`${label}.acceptedEffect must be null for rejected results`);
  }
  if (value.afterWorldRevision !== value.beforeWorldRevision) {
    throw new TypeError(`${label}.afterWorldRevision must match beforeWorldRevision for rejected results`);
  }
  if (value.afterInventoryRevision !== value.beforeInventoryRevision) {
    throw new TypeError(`${label}.afterInventoryRevision must match beforeInventoryRevision for rejected results`);
  }
  if (value.afterTargetRevision !== value.beforeTargetRevision) {
    throw new TypeError(`${label}.afterTargetRevision must match beforeTargetRevision for rejected results`);
  }
}

function validatePlayerState(value: unknown, version: number): PlayerState {
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
  if (version >= 3) {
    player.airTicks = assertInteger(requireField(obj, "airTicks", "player.airTicks"), "player.airTicks", 0, MAX_SAFE_INTEGER);
    player.airTime = player.airTicks;
    player.previousJumpHeld = assertBoolean(requireField(obj, "previousJumpHeld", "player.previousJumpHeld"), "player.previousJumpHeld");
    const swingElapsedTicks = requireField(obj, "swingElapsedTicks", "player.swingElapsedTicks");
    player.swingElapsedTicks = swingElapsedTicks === null ? null : assertInteger(swingElapsedTicks, "player.swingElapsedTicks", 0, MAX_SAFE_INTEGER);
    player.faucetCooldownUntilTick = assertInteger(requireField(obj, "faucetCooldownUntilTick", "player.faucetCooldownUntilTick"), "player.faucetCooldownUntilTick", 0, MAX_SAFE_INTEGER);
  } else {
    const legacyAirTime = assertFiniteNumber(requireField(obj, "airTime", "player.airTime"), "player.airTime");
    if (legacyAirTime < 0) throw new TypeError("player.airTime must be >= 0");
    player.airTime = normalizeLegacyAirTicksSeconds(legacyAirTime);
    player.airTicks = player.airTime;
    player.previousJumpHeld = false;
    player.swingElapsedTicks = null;
    player.faucetCooldownUntilTick = 0;
  }
  player.crouching = assertBoolean(requireField(obj, "crouching", "player.crouching"), "player.crouching");
  player.lookingUp = assertBoolean(requireField(obj, "lookingUp", "player.lookingUp"), "player.lookingUp");
  player.swimming = assertBoolean(requireField(obj, "swimming", "player.swimming"), "player.swimming");
  if (version >= WORLD_STATE_SCHEMA_VERSION) {
    player.input = validatePersistedInput(requireField(obj, "input", "player.input"));
    player.inventoryRevision = assertInteger(requireField(obj, "inventoryRevision", "player.inventoryRevision"), "player.inventoryRevision", 0, MAX_SAFE_INTEGER);
    player.pendingRefunds = validatePendingRefunds(requireField(obj, "pendingRefunds", "player.pendingRefunds"));
  } else {
    player.input = Object.prototype.hasOwnProperty.call(obj, "input") ? validatePersistedInput(obj["input"]) : createDefaultPlayerState(id).input;
    player.inventoryRevision = Object.prototype.hasOwnProperty.call(obj, "inventoryRevision") ? assertInteger(obj["inventoryRevision"], "player.inventoryRevision", 0, MAX_SAFE_INTEGER) : 0;
    player.pendingRefunds = Object.prototype.hasOwnProperty.call(obj, "pendingRefunds") ? validatePendingRefunds(obj["pendingRefunds"]) : {};
  }
  player.inventory = validateInventory(requireField(obj, "inventory", "player.inventory"));
  player.hotbar = validateHotbar(requireField(obj, "hotbar", "player.hotbar"));
  player.activeHotbarSlot = assertInteger(requireField(obj, "activeHotbarSlot", "player.activeHotbarSlot"), "player.activeHotbarSlot", 0, 9);
  return player;
}

function validateFallingObjectState(value: unknown, version: number): FallingObjectState {
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
  const falling = createDefaultFallingObjectState(
    id,
    materialId,
    assertInteger(requireField(obj, "x", "fallingObject.x"), "fallingObject.x"),
    assertFiniteNumber(requireField(obj, "y", "fallingObject.y"), "fallingObject.y"),
    assertInteger(requireField(obj, "restY", "fallingObject.restY"), "fallingObject.restY"),
    assertFiniteNumber(requireField(obj, "vy", "fallingObject.vy"), "fallingObject.vy"),
    offsets,
  );
  const provenanceValue = Object.prototype.hasOwnProperty.call(obj, "provenance")
    ? obj["provenance"]
    : (version >= WORLD_STATE_SCHEMA_VERSION ? requireField(obj, "provenance", "fallingObject.provenance") : { kind: "legacy" });
  falling.provenance = validateFallingProvenance(provenanceValue);
  return falling;
}

function validateFallingProvenance(value: unknown): FallingObjectProvenance {
  if (value === null || typeof value !== "object") throw new TypeError("fallingObject.provenance must be an object");
  const obj = value as Record<string, unknown>;
  if (obj["kind"] === "legacy") return { kind: "legacy" };
  if (obj["kind"] === "placement") {
    return {
      kind: "placement",
      actorId: parsePlayerId(requireField(obj, "actorId", "fallingObject.provenance.actorId")),
      commandId: parseCommandId(requireField(obj, "commandId", "fallingObject.provenance.commandId")),
      sourceSlot: assertInteger(requireField(obj, "sourceSlot", "fallingObject.provenance.sourceSlot"), "fallingObject.provenance.sourceSlot", 0, 9),
      materialId: assertMaterialId(requireField(obj, "materialId", "fallingObject.provenance.materialId"), "fallingObject.provenance.materialId"),
      amount: 1,
    };
  }
  return value as FallingObjectProvenance;
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
  if (totalCells > MAX_GRID_CELLS) throw new TypeError("grid dimensions exceed the maximum allowed cell count");
  const ids = assertArray(requireField(obj, "ids", "grid.ids"), "grid.ids");
  const shade = assertArray(requireField(obj, "shade", "grid.shade"), "grid.shade");
  const auxiliary = assertArray(requireField(obj, "auxiliary", "grid.auxiliary"), "grid.auxiliary");
  const objectMembership = assertArray(requireField(obj, "objectMembership", "grid.objectMembership"), "grid.objectMembership");
  const cellRevisions = Object.prototype.hasOwnProperty.call(obj, "cellRevisions") ? assertArray(obj["cellRevisions"], "grid.cellRevisions") : Array(totalCells).fill(0);
  if (ids.length !== totalCells) throw new TypeError("grid.ids length mismatch");
  if (shade.length !== totalCells) throw new TypeError("grid.shade length mismatch");
  if (auxiliary.length !== totalCells) throw new TypeError("grid.auxiliary length mismatch");
  if (cellRevisions.length !== totalCells) throw new TypeError("grid.cellRevisions length mismatch");

  const grid = new Grid(width, height);
  for (let i = 0; i < ids.length; i++) {
    const materialId = assertMaterialId(ids[i], `grid.ids[${i}]`);
    const shadeValue = assertInteger(shade[i], `grid.shade[${i}]`, -128, 127);
    const auxValue = assertInteger(auxiliary[i], `grid.auxiliary[${i}]`, -128, 127);
    grid.ids[i] = materialId;
    grid.shade[i] = shadeValue;
    grid.auxiliary[i] = assertAuxiliaryValueForMaterialId(materialId, auxValue, `grid.auxiliary[${i}]`);
    grid.objectIds[i] = null;
    grid.cellRevisions[i] = assertInteger(cellRevisions[i], `grid.cellRevisions[${i}]`, 0, MAX_SAFE_INTEGER) >>> 0;
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
    if (previousMaterial !== undefined && previousMaterial !== materialId) throw new TypeError("grid.objectMembership contains inconsistent materials for the same object ID");
    materialByObjectId.set(objectId, materialId);
    grid.objectIds[grid.index(x, y)] = objectId;
  }
  grid.rebuildObjectCellIndex();
  return grid;
}

function cloneInventoryCounts(inventory: InventoryCounts): InventoryCounts {
  const normalized = {} as InventoryCounts;
  for (const key of Object.keys(inventory).sort(compareStringCodeUnits)) {
    normalized[key] = inventory[key];
  }
  return normalized;
}

function cloneSerializableValue<T>(value: T): T {
  return globalThis.structuredClone ? globalThis.structuredClone(value) as T : JSON.parse(JSON.stringify(value)) as T;
}

function cloneGameplayRandomState(random: GameplayRandomState): GameplayRandomStateDto {
  return {
    algorithm: random.algorithm,
    seed: random.seed,
    state: random.state,
  };
}

function validateGameplayRandomState(value: unknown): GameplayRandomState {
  const obj = assertObject(value, "random");
  const algorithm = requireField(obj, "algorithm", "random.algorithm");
  if (algorithm !== "mulberry32-v1") {
    throw new TypeError("random.algorithm must be 'mulberry32-v1'");
  }
  const seed = assertInteger(requireField(obj, "seed", "random.seed"), "random.seed", 0, 0x1_0000_0000 - 1);
  const state = assertInteger(requireField(obj, "state", "random.state"), "random.state", 0, 0x1_0000_0000 - 1);
  const random = createGameplayRandomState(seed);
  random.state = state;
  return random;
}

function validateCommandLedger(value: unknown): CommandLedgerState {
  const obj = assertObject(value, "commandLedger");
  const actorHighWater = assertObject(requireField(obj, "actorHighWater", "commandLedger.actorHighWater"), "commandLedger.actorHighWater");
  const recent = assertArray(requireField(obj, "recent", "commandLedger.recent"), "commandLedger.recent");
  const normalized: CommandLedgerState = { actorHighWater: {}, recent: [] };
  for (const [key, entry] of Object.entries(actorHighWater)) {
    normalized.actorHighWater[key] = assertInteger(entry, `commandLedger.actorHighWater.${key}`, 0, MAX_SAFE_INTEGER);
  }
  for (const entry of recent) {
    normalized.recent.push(validateCommandReceipt(entry, "commandLedger.recent[]"));
  }
  return normalized;
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
      cellRevisions: Array.from(grid.cellRevisions),
    },
    random: cloneGameplayRandomState(world.random),
    players: Object.fromEntries(Object.entries(world.players).sort(([left], [right]) => compareStringCodeUnits(left, right)).map(([key, value]) => [key, serializePlayerState(value)])),
    fallingObjects: Object.fromEntries(Object.entries(world.fallingObjects).sort(([left], [right]) => compareStringCodeUnits(left, right)).map(([key, value]) => [key, serializeFallingObjectState(value)])),
    paused: world.paused,
    tick: world.tick,
    time: { dayNightTick: world.time.dayNightTick },
    weather: serializeWeatherState(world.weather),
    nextPlayerOrdinal: world.nextPlayerOrdinal,
    nextObjectOrdinal: world.nextObjectOrdinal,
    ownerPlayerId: world.ownerPlayerId,
    worldRevision: world.worldRevision,
    nextAuthorityOrder: world.nextAuthorityOrder,
    commandLedger: serializeCommandLedger(world.commandLedger),
  };
}

export function serializePlayerState(player: PlayerState): PlayerStateDto {
  const input = player.input ?? {
    left: false,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
    mineHeld: false,
  };
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
    airTicks: typeof player.airTicks === "number" ? player.airTicks : (typeof player.airTime === "number" ? Math.max(0, Math.round(player.airTime)) : 0),
    previousJumpHeld: typeof player.previousJumpHeld === "boolean" ? player.previousJumpHeld : false,
    swingElapsedTicks: typeof player.swingElapsedTicks === "number" || player.swingElapsedTicks === null ? player.swingElapsedTicks : null,
    faucetCooldownUntilTick: typeof player.faucetCooldownUntilTick === "number" ? player.faucetCooldownUntilTick : 0,
    crouching: player.crouching,
    lookingUp: player.lookingUp,
    swimming: player.swimming,
    input: {
      left: Boolean(input.left),
      right: Boolean(input.right),
      jumpHeld: Boolean(input.jumpHeld),
      crouchHeld: Boolean(input.crouchHeld),
      lookUpHeld: Boolean(input.lookUpHeld),
      mineHeld: Boolean(input.mineHeld),
    },
    inventory: cloneInventoryCounts(player.inventory),
    hotbar: cloneHotbar(player.hotbar),
    activeHotbarSlot: typeof player.activeHotbarSlot === "number" ? player.activeHotbarSlot : 0,
    inventoryRevision: typeof player.inventoryRevision === "number" ? player.inventoryRevision : 0,
    pendingRefunds: { ...(player.pendingRefunds ?? {}) },
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
    provenance: objectState.provenance ?? { kind: "legacy" },
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

export function serializeCommandLedger(commandLedger: CommandLedgerState): CommandLedgerDto {
  return {
    actorHighWater: { ...commandLedger.actorHighWater },
    recent: commandLedger.recent.map((receipt, index) => cloneSerializableValue(validateCommandReceipt(receipt, `commandLedger.recent[${index}]`))),
  };
}

function validateObjectIdentityInvariants(world: WorldState): void {
  const fallingIds = new Set<string>();
  for (const objectState of Object.values(world.fallingObjects)) {
    if (fallingIds.has(objectState.id)) throw new TypeError("falling object IDs must be unique");
    fallingIds.add(objectState.id);
  }
  for (let i = 0; i < world.grid.objectIds.length; i++) {
    const objectId = world.grid.objectIds[i];
    if (!objectId) continue;
    if (fallingIds.has(objectId)) throw new TypeError("falling and placed object IDs must be disjoint");
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
  if (version !== 1 && version !== 2 && version !== 3 && version !== WORLD_STATE_SCHEMA_VERSION) {
    throw new TypeError("unsupported world state schema version");
  }

  const roomId = parseRoomId(requireField(obj, "roomId", "roomId"));
  const world = createDefaultWorldState(roomId);
  world.grid = validateGrid(requireField(obj, "grid", "grid"));
  world.players = {};
  const players = assertObject(requireField(obj, "players", "players"), "players");
  for (const [key, playerEntry] of Object.entries(players)) {
    const player = validatePlayerState(playerEntry, version as number);
    world.players[player.id] = player;
    if (key !== player.id) throw new TypeError("player key mismatch");
  }
  world.fallingObjects = {};
  const fallingObjects = assertObject(requireField(obj, "fallingObjects", "fallingObjects"), "fallingObjects");
  for (const [key, objectEntry] of Object.entries(fallingObjects)) {
    const objectState = validateFallingObjectState(objectEntry, version as number);
    world.fallingObjects[objectState.id] = objectState;
    if (key !== objectState.id) throw new TypeError("falling object key mismatch");
  }
  world.paused = assertBoolean(requireField(obj, "paused", "paused"), "paused");
  const timeValue = requireField(obj, "time", "time");
  const timeObj = typeof timeValue === "object" && timeValue !== null ? (timeValue as Record<string, unknown>) : undefined;
  if (!timeObj) throw new TypeError("time is required");
  if (version === 1 || version === 2) {
    if (!Object.prototype.hasOwnProperty.call(timeObj, "dayNightCycle")) throw new TypeError("time.dayNightCycle is required");
    world.time.dayNightCycle = assertFiniteNumber(timeObj["dayNightCycle"], "time.dayNightCycle");
    world.tick = 0;
    world.time.dayNightTick = normalizeDayNightTick(world.time.dayNightCycle);
  } else {
    if (!Object.prototype.hasOwnProperty.call(timeObj, "dayNightTick")) throw new TypeError("time.dayNightTick is required");
    world.tick = assertInteger(requireField(obj, "tick", "tick"), "tick", 0, MAX_SAFE_INTEGER);
    world.time.dayNightTick = assertInteger(timeObj["dayNightTick"], "time.dayNightTick", 0, DAY_NIGHT_CYCLE_TICKS - 1);
  }
  world.time.dayNightCycle = world.time.dayNightTick / DAY_NIGHT_CYCLE_TICKS;
  world.weather = validateWeatherState(requireField(obj, "weather", "weather"));
  world.nextPlayerOrdinal = assertInteger(requireField(obj, "nextPlayerOrdinal", "nextPlayerOrdinal"), "nextPlayerOrdinal", 1, MAX_SAFE_INTEGER);
  world.nextObjectOrdinal = assertInteger(requireField(obj, "nextObjectOrdinal", "nextObjectOrdinal"), "nextObjectOrdinal", 1, MAX_SAFE_INTEGER);
  world.ownerPlayerId = Object.prototype.hasOwnProperty.call(obj, "ownerPlayerId") ? (obj["ownerPlayerId"] === null ? null : parsePlayerId(obj["ownerPlayerId"])) : (Object.keys(world.players).length > 0 ? parsePlayerId(Object.keys(world.players).sort(compareStringCodeUnits)[0]!) : null);
  world.worldRevision = Object.prototype.hasOwnProperty.call(obj, "worldRevision") ? assertInteger(obj["worldRevision"], "worldRevision", 0, MAX_SAFE_INTEGER) : 0;
  world.nextAuthorityOrder = Object.prototype.hasOwnProperty.call(obj, "nextAuthorityOrder") ? assertInteger(obj["nextAuthorityOrder"], "nextAuthorityOrder", 1, MAX_SAFE_INTEGER) : 1;
  world.commandLedger = Object.prototype.hasOwnProperty.call(obj, "commandLedger") ? validateCommandLedger(obj["commandLedger"]) : { actorHighWater: {}, recent: [] };
  if (version === WORLD_STATE_SCHEMA_VERSION) {
    for (const key of ["ownerPlayerId", "worldRevision", "nextAuthorityOrder", "commandLedger"]) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new TypeError(`${key} is required for schema v4`);
      }
    }
  }
  world.random = version === 1 ? createGameplayRandomState(DEFAULT_RANDOM_SEED) : validateGameplayRandomState(requireField(obj, "random", "random"));
  world.grid.rebuildObjectCellIndex();
  validateObjectIdentityInvariants(world);
  return world;
}
