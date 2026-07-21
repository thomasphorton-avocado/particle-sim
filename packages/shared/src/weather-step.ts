import { placeWorldCell } from "./grid.js";
import { MaterialId } from "./materials.js";
import { nextFloat, nextInt } from "./random.js";
import type { WeatherState, WorldState } from "./world-state.js";

type WeatherKind = WeatherState["kind"];

export const CLEAR_MIN_TICKS = 900;
export const CLEAR_MAX_TICKS = 1800;
export const RAIN_MIN_TICKS = 600;
export const RAIN_MAX_TICKS = 1500;
export const STORM_MIN_TICKS = 300;
export const STORM_MAX_TICKS = 900;
export const RAIN_INTENSITY = 0.15;
export const STORM_INTENSITY = 0.4;
export const MAX_DROPLETS_PER_TICK = 3;
export const LIGHTNING_MIN_COOLDOWN_TICKS = 90;
export const LIGHTNING_MAX_COOLDOWN_TICKS = 360;
export const LIGHTNING_FLASH_TICKS = 8;
export const WIND_MAX = 4;

const VISUAL_TIME_MODULO = 1_000_000_000;

function episodeDurationFor(kind: WeatherKind, world: WorldState): number {
  switch (kind) {
    case "clear":
      return CLEAR_MIN_TICKS + nextInt(world.random, CLEAR_MAX_TICKS - CLEAR_MIN_TICKS + 1);
    case "rain":
      return RAIN_MIN_TICKS + nextInt(world.random, RAIN_MAX_TICKS - RAIN_MIN_TICKS + 1);
    case "storm":
      return STORM_MIN_TICKS + nextInt(world.random, STORM_MAX_TICKS - STORM_MIN_TICKS + 1);
  }
}

function pickNextKind(kind: WeatherKind, world: WorldState): WeatherKind {
  const roll = nextFloat(world.random);
  switch (kind) {
    case "clear":
      return roll < 0.8 ? "rain" : "storm";
    case "rain":
      return roll < 0.5 ? "clear" : "storm";
    case "storm":
      return roll < 0.6 ? "rain" : "clear";
  }
}

function clampDrift(wind: number): number {
  if (wind < -WIND_MAX) return -WIND_MAX;
  if (wind > WIND_MAX) return WIND_MAX;
  return wind;
}

function beginEpisode(world: WorldState, weather: WeatherState, kind: WeatherKind): void {
  weather.kind = kind;
  weather.episodeElapsed = 0;
  weather.episodeDuration = episodeDurationFor(kind, world);
  weather.wind = nextInt(world.random, WIND_MAX * 2 + 1) - WIND_MAX;
  weather.rainAccumulator = 0;
  weather.lightningFlash = null;
  weather.boltX = null;
  weather.boltY = null;
  weather.lightningCooldown = kind === "storm" ? rollLightningCooldown(world) : null;
}

function rollLightningCooldown(world: WorldState): number {
  return (
    LIGHTNING_MIN_COOLDOWN_TICKS +
    nextInt(world.random, LIGHTNING_MAX_COOLDOWN_TICKS - LIGHTNING_MIN_COOLDOWN_TICKS + 1)
  );
}

function spawnRain(world: WorldState, weather: WeatherState): void {
  const intensity = weather.kind === "storm" ? STORM_INTENSITY : RAIN_INTENSITY;
  weather.rainAccumulator += intensity;
  const grid = world.grid;
  const drift = clampDrift(weather.wind);
  if (grid.width <= 0 || grid.height <= 0) {
    return;
  }

  let dropped = 0;
  while (weather.rainAccumulator >= 1 && dropped < MAX_DROPLETS_PER_TICK) {
    weather.rainAccumulator -= 1;
    dropped += 1;
    const x = nextInt(world.random, grid.width);
    if (!grid.inBounds(x, 0)) continue;
    if (grid.get(x, 0) !== MaterialId.Empty) continue;
    placeWorldCell(world, x, 0, MaterialId.Water);
    if (drift !== 0) {
      grid.setWaterLiquidMemory(x, 0, drift);
    }
    grid.markUpdated(x, 0);
  }
}

function stepLightning(world: WorldState, weather: WeatherState): void {
  if (weather.kind !== "storm") return;

  if (weather.lightningFlash !== null) {
    weather.lightningFlash -= 1;
    if (weather.lightningFlash <= 0) {
      weather.lightningFlash = null;
      weather.boltX = null;
      weather.boltY = null;
    }
    return;
  }

  if (weather.lightningCooldown === null) {
    weather.lightningCooldown = rollLightningCooldown(world);
    return;
  }

  weather.lightningCooldown -= 1;
  if (weather.lightningCooldown > 0) return;

  weather.lightningFlash = LIGHTNING_FLASH_TICKS;
  if (world.grid.width > 0 && world.grid.height > 0) {
    weather.boltX = nextInt(world.random, world.grid.width);
    weather.boltY = nextInt(world.random, Math.max(1, Math.floor(world.grid.height / 2)));
    weather.boltSeed = nextInt(world.random, 0x7fffffff);
  } else {
    weather.boltX = null;
    weather.boltY = null;
    weather.boltSeed = 0;
  }
  weather.lightningCooldown = rollLightningCooldown(world);
}

export function stepWeather(world: WorldState): void {
  if (world.grid.width <= 0 || world.grid.height <= 0) {
    return;
  }

  const weather = world.weather;

  weather.visualTime = (weather.visualTime + 1) % VISUAL_TIME_MODULO;
  weather.episodeElapsed += 1;

  if (weather.episodeElapsed >= weather.episodeDuration) {
    const next: WeatherKind = weather.episodeDuration <= 0 ? "clear" : pickNextKind(weather.kind, world);
    beginEpisode(world, weather, next);
  }

  if (weather.kind === "rain" || weather.kind === "storm") {
    spawnRain(world, weather);
  }

  stepLightning(world, weather);
}
