import { createRoomId } from "@particle-sim/shared";

export interface ServerConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly maxRooms: number;
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly tickHz: number;
  readonly maxCatchUpTicks: number;
  readonly defaultShutdownGraceMs: number;
  readonly idleCleanupThresholdMs: number;
  readonly reconnectTimeoutMs: number;
  readonly reconnectTombstoneLimit: number;
  readonly healthPath: string;
  readonly roomsPath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseInteger(value: string | undefined, fallback: number, _key: string, minimum: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new ConfigError(`${_key} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseString(value: string | undefined, fallback: string, _key: string): string {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}

export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = parseString(env["NODE_ENV"], "development", "NODE_ENV") as ServerConfig["nodeEnv"];
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new ConfigError("NODE_ENV must be one of development, test, production");
  }

  const host = parseString(env["HOST"], "127.0.0.1", "HOST");
  const port = parseInteger(env["PORT"], 3000, "PORT", 0);
  const maxRooms = parseInteger(env["MAX_ROOMS"], 32, "MAX_ROOMS", 1);
  const minCapacity = parseInteger(env["MIN_CAPACITY"], 2, "MIN_CAPACITY", 2);
  const maxCapacity = parseInteger(env["MAX_CAPACITY"], 4, "MAX_CAPACITY", 2);
  const tickHz = parseInteger(env["TICK_HZ"], 60, "TICK_HZ", 1);
  const maxCatchUpTicks = parseInteger(env["MAX_CATCH_UP_TICKS"], 3, "MAX_CATCH_UP_TICKS", 0);
  const defaultShutdownGraceMs = parseInteger(env["SHUTDOWN_GRACE_MS"], 2000, "SHUTDOWN_GRACE_MS", 1);
  const idleCleanupThresholdMs = parseInteger(env["IDLE_CLEANUP_THRESHOLD_MS"], 30_000, "IDLE_CLEANUP_THRESHOLD_MS", 1);
  const reconnectTimeoutMs = parseInteger(env["RECONNECT_TIMEOUT_MS"], 10_000, "RECONNECT_TIMEOUT_MS", 1);
  const reconnectTombstoneLimit = parseInteger(env["RECONNECT_TOMBSTONE_LIMIT"], 8, "RECONNECT_TOMBSTONE_LIMIT", 1);

  if (minCapacity > maxCapacity) {
    throw new ConfigError("MIN_CAPACITY cannot exceed MAX_CAPACITY");
  }
  if (maxCapacity < 2 || maxCapacity > 4) {
    throw new ConfigError("MAX_CAPACITY must be between 2 and 4");
  }
  if (minCapacity < 2 || minCapacity > 4) {
    throw new ConfigError("MIN_CAPACITY must be between 2 and 4");
  }

  const config: ServerConfig = {
    nodeEnv,
    host,
    port,
    maxRooms,
    minCapacity,
    maxCapacity,
    tickHz,
    maxCatchUpTicks,
    defaultShutdownGraceMs,
    idleCleanupThresholdMs,
    reconnectTimeoutMs,
    reconnectTombstoneLimit,
    healthPath: "/healthz",
    roomsPath: "/rooms",
  };

  return Object.freeze(config) as ServerConfig;
}

export function createDefaultRoomId(index: number): string {
  return createRoomId(`room_${index.toString().padStart(4, "0")}`);
}
