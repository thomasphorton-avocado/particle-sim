export interface GameplayRandomState {
  algorithm: "mulberry32-v1";
  seed: number;
  state: number;
}

const UINT32_MAX = 0x1_0000_0000;
const UINT32_MASK = 0xffff_ffff;

function assertInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return value;
}

function assertUint32(value: unknown, label: string): number {
  const integer = assertInteger(value, label);
  if (integer < 0 || integer > UINT32_MASK) {
    throw new RangeError(`${label} must be in range 0..0xffffffff`);
  }
  return integer >>> 0;
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function assertProbability(value: unknown, label: string): number {
  const number = assertFiniteNumber(value, label);
  if (number < 0 || number > 1) {
    throw new RangeError(`${label} must be in range 0..1`);
  }
  return number;
}

function assertRandomStateShape(random: unknown): GameplayRandomState {
  if (typeof random !== "object" || random === null || Array.isArray(random)) {
    throw new TypeError("random must be an object");
  }
  const obj = random as Record<string, unknown>;
  const algorithm = obj["algorithm"];
  if (algorithm !== "mulberry32-v1") {
    throw new TypeError("random.algorithm must be 'mulberry32-v1'");
  }
  return {
    algorithm: "mulberry32-v1",
    seed: assertUint32(obj["seed"], "random.seed"),
    state: assertUint32(obj["state"], "random.state"),
  };
}

function hashVisualValue(seed: number, x: number, y: number, materialId: number, salt: number): number {
  const baseSeed = assertUint32(seed, "seed");
  const xValue = assertInteger(x, "x");
  const yValue = assertInteger(y, "y");
  const materialValue = assertInteger(materialId, "materialId");
  const saltValue = assertInteger(salt, "salt");
  let value = (baseSeed + 0x9e3779b9) >>> 0;
  value = (value ^ (xValue + 0x85ebca6b)) >>> 0;
  value = (value ^ (yValue + 0xc2b2ae3d)) >>> 0;
  value = (value ^ (materialValue + 0x27d4eb2d)) >>> 0;
  value = (value ^ (saltValue + 0x165667b1)) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  value = Math.imul(value, 0x85ebca6b);
  value = (value ^ (value >>> 13)) >>> 0;
  value = Math.imul(value, 0xc2b2ae3d);
  value = (value ^ (value >>> 16)) >>> 0;
  return value >>> 0;
}

export function createGameplayRandomState(seed: number): GameplayRandomState {
  return {
    algorithm: "mulberry32-v1",
    seed: assertUint32(seed, "seed"),
    state: assertUint32(seed, "seed"),
  };
}

export function nextUint32(random: GameplayRandomState): number {
  const state = assertRandomStateShape(random);
  state.state = (state.state + 0x6d2b79f5) >>> 0;
  let t = state.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
  const result = (t ^ (t >>> 14)) >>> 0;
  random.state = state.state;
  return result;
}

export function nextFloat(random: GameplayRandomState): number {
  return nextUint32(random) / UINT32_MAX;
}

export function nextInt(random: GameplayRandomState, maxExclusive: number): number {
  const integer = assertInteger(maxExclusive, "maxExclusive");
  if (integer < 1 || integer > UINT32_MAX) {
    throw new RangeError("maxExclusive must be in range 1..0x1_0000_0000");
  }
  return Math.floor(nextFloat(random) * integer);
}

export function nextBool(random: GameplayRandomState, probability: number = 0.5): boolean {
  const p = assertProbability(probability, "probability");
  return nextFloat(random) < p;
}

export function hashVisualShade(seed: number, x: number, y: number, materialId: number, salt: number = 0): number {
  return (hashVisualValue(seed, x, y, materialId, salt) % 21) - 10;
}

export function hashVisualShadeInRange(seed: number, x: number, y: number, materialId: number, salt: number, min: number, max: number): number {
  const lower = assertInteger(min, "min");
  const upper = assertInteger(max, "max");
  if (lower > upper) {
    throw new RangeError("min must be <= max");
  }
  const span = upper - lower + 1;
  return lower + (hashVisualValue(seed, x, y, materialId, salt) % span);
}
