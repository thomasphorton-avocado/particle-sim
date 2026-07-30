import { createCommandId, parseGameplayCommand, type CommandId, type GameplayCommand, type PlayerId, type RoomId } from "@particle-sim/shared";
import type { Clock } from "./scheduler.js";
import type { RoomCommandAck, RoomCommandAdmissionResult } from "./types.js";

export interface RoomAdmissionPolicyConfig {
  readonly maxBatchSize: number;
  readonly rateWindowMs: number;
  readonly rateLimit: number;
  readonly maxQueuedCommandsPerPlayer: number;
  readonly maxQueuedCommandsPerRoom: number;
  readonly maxCommandsPerPlayerPerTick: number;
  readonly maxCommandsPerTick: number;
  readonly maxAckHistory: number;
}

export interface PendingCommandEntry {
  readonly receiveOrdinal: number;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly playerId: PlayerId;
  readonly actorSequence: number;
  readonly command: GameplayCommand;
}

interface EnqueueCommandOptions {
  readonly roomId: RoomId;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly playerId: PlayerId;
  readonly actorSequence: number;
  readonly command: GameplayCommand;
}

interface RateWindowState {
  windowStartMs: number;
  count: number;
}

export class RoomAdmissionPolicy {
  #config: RoomAdmissionPolicyConfig;
  #clock: Clock;
  #pendingCommands: PendingCommandEntry[];
  #connectionRateWindows: Map<string, RateWindowState>;
  #playerRateWindows: Map<string, RateWindowState>;
  #ackHistory: RoomCommandAck[];
  #nextReceiveOrdinal: number;
  #drainCursor: number;

  constructor(config: RoomAdmissionPolicyConfig, clock: Clock) {
    this.#config = config;
    this.#clock = clock;
    this.#pendingCommands = [];
    this.#connectionRateWindows = new Map();
    this.#playerRateWindows = new Map();
    this.#ackHistory = [];
    this.#nextReceiveOrdinal = 1;
    this.#drainCursor = 0;
  }

  get pendingCommandCount(): number {
    return this.#pendingCommands.length;
  }

  get ackHistory(): readonly RoomCommandAck[] {
    return this.#ackHistory;
  }

  enqueueCommand(options: EnqueueCommandOptions): RoomCommandAdmissionResult & { entry?: PendingCommandEntry } {
    if (!parseGameplayCommand(options.command)) {
      return {
        accepted: false,
        code: "malformed_message",
        message: "command payload is malformed",
      };
    }
    if (!this.#consumeRateLimit(options.connectionId, options.playerId)) {
      return {
        accepted: false,
        code: "rate_limited",
        message: "command rate limit exceeded",
      };
    }
    if (this.#pendingCommands.length >= this.#config.maxQueuedCommandsPerRoom) {
      return {
        accepted: false,
        code: "room_backlog",
        message: "room command backlog is full",
      };
    }
    const playerQueueSize = this.#pendingCommands.filter((entry) => entry.playerId === options.playerId).length;
    if (playerQueueSize >= this.#config.maxQueuedCommandsPerPlayer) {
      return {
        accepted: false,
        code: "player_backlog",
        message: "player command backlog is full",
      };
    }
    const entry: PendingCommandEntry = {
      receiveOrdinal: this.#nextReceiveOrdinal,
      membershipId: options.membershipId,
      sessionId: options.sessionId,
      connectionId: options.connectionId,
      generation: options.generation,
      playerId: options.playerId,
      actorSequence: options.actorSequence,
      command: options.command,
    };
    this.#nextReceiveOrdinal += 1;
    this.#pendingCommands.push(entry);
    this.#pendingCommands.sort((left, right) => left.receiveOrdinal - right.receiveOrdinal);
    return { accepted: true, entry };
  }

  takeNextBatch(maxCommandsPerTick: number, maxCommandsPerPlayerPerTick: number): PendingCommandEntry[] {
    if (this.#pendingCommands.length === 0) {
      return [];
    }

    const ordered = [...this.#pendingCommands].sort((left, right) => left.receiveOrdinal - right.receiveOrdinal);
    const effectiveMaxCommandsPerTick = Math.min(maxCommandsPerTick, this.#config.maxBatchSize);
    const players = this.#orderedPlayers(ordered);
    if (players.length === 0) {
      return [];
    }

    const selected: PendingCommandEntry[] = [];
    const perPlayerCount = new Map<PlayerId, number>();
    let nextPlayerIndex = this.#drainCursor % players.length;
    const remaining = ordered.slice();

    while (selected.length < effectiveMaxCommandsPerTick) {
      let forwarded = false;
      for (let offset = 0; offset < players.length; offset += 1) {
        const playerId = players[(nextPlayerIndex + offset) % players.length];
        const playerCount = perPlayerCount.get(playerId) ?? 0;
        if (playerCount >= maxCommandsPerPlayerPerTick) {
          continue;
        }
        const entryIndex = remaining.findIndex((entry) => entry.playerId === playerId);
        if (entryIndex < 0) {
          continue;
        }
        const [entry] = remaining.splice(entryIndex, 1);
        selected.push(entry);
        perPlayerCount.set(playerId, playerCount + 1);
        nextPlayerIndex = (nextPlayerIndex + 1) % players.length;
        forwarded = true;
        break;
      }
      if (!forwarded) {
        break;
      }
    }

    this.#pendingCommands = remaining;
    this.#drainCursor = (this.#drainCursor + 1) % players.length;
    return selected;
  }

  recordAck(ack: RoomCommandAck): void {
    this.#ackHistory = [...this.#ackHistory, ack].slice(-this.#config.maxAckHistory);
  }

  clearPendingForSession(sessionId: string): void {
    this.#pendingCommands = this.#pendingCommands.filter((entry) => entry.sessionId !== sessionId);
  }

  clearPendingForConnection(connectionId: string): void {
    this.#pendingCommands = this.#pendingCommands.filter((entry) => entry.connectionId !== connectionId);
    this.#connectionRateWindows.delete(connectionId);
  }

  clearPendingForPlayer(playerId: PlayerId): void {
    this.#pendingCommands = this.#pendingCommands.filter((entry) => entry.playerId !== playerId);
    this.#playerRateWindows.delete(playerId);
  }

  clear(): void {
    this.#pendingCommands = [];
    this.#connectionRateWindows.clear();
    this.#playerRateWindows.clear();
    this.#ackHistory = [];
    this.#nextReceiveOrdinal = 1;
    this.#drainCursor = 0;
  }

  #orderedPlayers(entries: PendingCommandEntry[]): PlayerId[] {
    const earliestByPlayer = new Map<PlayerId, number>();
    for (const entry of entries) {
      const current = earliestByPlayer.get(entry.playerId);
      if (current === undefined || entry.receiveOrdinal < current) {
        earliestByPlayer.set(entry.playerId, entry.receiveOrdinal);
      }
    }
    return Array.from(earliestByPlayer.entries())
      .sort((left, right) => {
        const byReceiveOrdinal = left[1] - right[1];
        if (byReceiveOrdinal !== 0) {
          return byReceiveOrdinal;
        }
        if (left[0] < right[0]) {
          return -1;
        }
        if (left[0] > right[0]) {
          return 1;
        }
        return 0;
      })
      .map(([playerId]) => playerId);
  }

  #consumeRateLimit(connectionId: string, playerId: PlayerId): boolean {
    const nowMs = this.#clock.nowMs();
    const connectionWindow = this.#getOrCreateWindow(this.#connectionRateWindows, connectionId, nowMs);
    if (!connectionWindow) {
      return false;
    }
    const playerWindow = this.#getOrCreateWindow(this.#playerRateWindows, playerId, nowMs);
    if (!playerWindow) {
      return false;
    }
    return true;
  }

  #getOrCreateWindow(windows: Map<string, RateWindowState>, key: string, nowMs: number): RateWindowState | null {
    const windowStartMs = Math.floor(nowMs / this.#config.rateWindowMs) * this.#config.rateWindowMs;
    const existing = windows.get(key);
    if (existing && existing.windowStartMs === windowStartMs) {
      if (existing.count >= this.#config.rateLimit) {
        return null;
      }
      existing.count += 1;
      return existing;
    }
    const nextWindow: RateWindowState = { windowStartMs, count: 1 };
    windows.set(key, nextWindow);
    return nextWindow;
  }
}

export function createRoomAdmissionPolicyConfig(overrides: Partial<RoomAdmissionPolicyConfig> = {}): RoomAdmissionPolicyConfig {
  return {
    maxBatchSize: 8,
    rateWindowMs: 1_000,
    rateLimit: 8,
    maxQueuedCommandsPerPlayer: 16,
    maxQueuedCommandsPerRoom: 64,
    maxCommandsPerPlayerPerTick: 8,
    maxCommandsPerTick: 8,
    maxAckHistory: 64,
    ...overrides,
  };
}

export function createRoomAdmissionCommandId(receiveOrdinal: number): CommandId {
  return createCommandId(`command_receive_${receiveOrdinal}`);
}
