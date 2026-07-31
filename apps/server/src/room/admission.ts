import { createCommandId, parseGameplayCommand, type CommandId, type GameplayCommand, type PlayerId } from "@particle-sim/shared";
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
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly playerId: PlayerId;
  readonly actorSequence: number;
  readonly command: GameplayCommand;
}

interface RateBucketState {
  tokens: number;
  lastRefillMs: number;
}

interface BatchSelectionState {
  totalUsed: number;
  perPlayerCount: Map<PlayerId, number>;
}

export class RoomAdmissionPolicy {
  #config: RoomAdmissionPolicyConfig;
  #clock: Clock;
  #pendingCommands: PendingCommandEntry[];
  #connectionRateBuckets: Map<string, RateBucketState>;
  #playerRateBuckets: Map<string, RateBucketState>;
  #ackHistory: RoomCommandAck[];
  #nextReceiveOrdinal: number;
  #drainCursor: number;

  constructor(config: RoomAdmissionPolicyConfig, clock: Clock) {
    this.#config = config;
    this.#clock = clock;
    this.#pendingCommands = [];
    this.#connectionRateBuckets = new Map();
    this.#playerRateBuckets = new Map();
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
    return { accepted: true, entry };
  }

  takeNextBatch(maxCommandsPerTick: number, maxCommandsPerPlayerPerTick: number, selectionState?: BatchSelectionState): PendingCommandEntry[] {
    if (this.#pendingCommands.length === 0) {
      return [];
    }

    const ordered = [...this.#pendingCommands];
    const effectiveMaxCommandsPerTick = Math.min(maxCommandsPerTick, this.#config.maxBatchSize);
    const players = this.#orderedPlayers(ordered);
    if (players.length === 0) {
      return [];
    }

    const selected: PendingCommandEntry[] = [];
    const perPlayerCount = selectionState?.perPlayerCount ?? new Map<PlayerId, number>();
    let totalUsed = selectionState?.totalUsed ?? 0;
    let nextPlayerIndex = this.#drainCursor % players.length;
    const remaining = ordered.slice();

    while (selected.length < effectiveMaxCommandsPerTick && totalUsed < effectiveMaxCommandsPerTick) {
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
        totalUsed += 1;
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
    if (selectionState) {
      selectionState.totalUsed = totalUsed;
      selectionState.perPlayerCount = perPlayerCount;
    }
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
    this.#connectionRateBuckets.delete(connectionId);
  }

  clearPendingForPlayer(playerId: PlayerId): void {
    this.#pendingCommands = this.#pendingCommands.filter((entry) => entry.playerId !== playerId);
    this.#playerRateBuckets.delete(playerId);
  }

  clear(): void {
    this.#pendingCommands = [];
    this.#connectionRateBuckets.clear();
    this.#playerRateBuckets.clear();
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
    const connectionBucket = this.#getOrCreateBucket(this.#connectionRateBuckets, connectionId, nowMs);
    if (!connectionBucket) {
      return false;
    }
    const playerBucket = this.#getOrCreateBucket(this.#playerRateBuckets, playerId, nowMs);
    if (!playerBucket) {
      return false;
    }
    return true;
  }

  #getOrCreateBucket(buckets: Map<string, RateBucketState>, key: string, nowMs: number): RateBucketState | null {
    const capacity = Math.max(1, this.#config.rateLimit);
    const refillPerMs = capacity / Math.max(1, this.#config.rateWindowMs);
    const existing = buckets.get(key);
    if (existing) {
      const elapsedMs = Math.max(0, nowMs - existing.lastRefillMs);
      const refillTokens = elapsedMs * refillPerMs;
      existing.tokens = Math.min(capacity, existing.tokens + refillTokens);
      existing.lastRefillMs = nowMs;
      if (existing.tokens < 1) {
        return null;
      }
      existing.tokens -= 1;
      return existing;
    }
    const nextBucket: RateBucketState = { tokens: capacity - 1, lastRefillMs: nowMs };
    buckets.set(key, nextBucket);
    return nextBucket;
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
