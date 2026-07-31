import { createCommandIdValue, parseGameplayCommand, type CommandId, type GameplayCommand, type PlayerId } from "@particle-sim/shared";
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
  readonly maxRateBuckets: number;
  readonly rateBucketTtlMs: number;
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
  readonly receiveOrdinal?: number;
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
  tick: number;
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
  #drainCursor: number;

  constructor(config: RoomAdmissionPolicyConfig, clock: Clock) {
    this.#config = config;
    this.#clock = clock;
    this.#pendingCommands = [];
    this.#connectionRateBuckets = new Map();
    this.#playerRateBuckets = new Map();
    this.#ackHistory = [];
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
      receiveOrdinal: options.receiveOrdinal ?? 0,
      membershipId: options.membershipId,
      sessionId: options.sessionId,
      connectionId: options.connectionId,
      generation: options.generation,
      playerId: options.playerId,
      actorSequence: options.actorSequence,
      command: options.command,
    };
    this.#pendingCommands.push(entry);
    return { accepted: true, entry };
  }

  takeNextBatch(
    maxCommandsPerTick: number,
    maxCommandsPerPlayerPerTick: number,
    selectionState?: BatchSelectionState,
    eligibleReceiveOrdinals?: Iterable<number>,
  ): PendingCommandEntry[] {
    if (this.#pendingCommands.length === 0) {
      return [];
    }

    const eligibleSet = eligibleReceiveOrdinals ? new Set(eligibleReceiveOrdinals) : null;
    const ordered = this.#pendingCommands.filter((entry) => (eligibleSet === null ? true : eligibleSet.has(entry.receiveOrdinal)));
    if (ordered.length === 0) {
      return [];
    }

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

    if (players.length > 0) {
      this.#drainCursor = (this.#drainCursor + 1) % players.length;
    }
    if (selectionState) {
      selectionState.totalUsed = totalUsed;
      selectionState.perPlayerCount = perPlayerCount;
    }
    return selected;
  }

  removeEntries(receiveOrdinals: Iterable<number>): void {
    const removeSet = new Set(receiveOrdinals);
    if (removeSet.size === 0) {
      return;
    }
    this.#pendingCommands = this.#pendingCommands.filter((entry) => !removeSet.has(entry.receiveOrdinal));
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

  clearRateBucketForConnection(connectionId: string): void {
    this.#connectionRateBuckets.delete(connectionId);
  }

  clearRateBucketForPlayer(playerId: PlayerId): void {
    this.#playerRateBuckets.delete(playerId);
  }

  clear(): void {
    this.#pendingCommands = [];
    this.#connectionRateBuckets.clear();
    this.#playerRateBuckets.clear();
    this.#ackHistory = [];
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
    const nowMs = Math.max(0, this.#clock.nowMs());
    this.#pruneBuckets(nowMs);
    const connectionBucket = this.#prepareBucketState(this.#connectionRateBuckets, connectionId, nowMs);
    if (!connectionBucket) {
      return false;
    }
    const playerBucket = this.#prepareBucketState(this.#playerRateBuckets, playerId, nowMs);
    if (!playerBucket) {
      return false;
    }
    this.#connectionRateBuckets.set(connectionId, connectionBucket);
    this.#playerRateBuckets.set(playerId, playerBucket);
    this.#pruneBuckets(nowMs);
    return true;
  }

  #prepareBucketState(buckets: Map<string, RateBucketState>, key: string, nowMs: number): RateBucketState | null {
    const capacity = Math.max(1, this.#config.rateLimit);
    const refillPerMs = capacity / Math.max(1, this.#config.rateWindowMs);
    const existing = buckets.get(key);
    if (existing) {
      const effectiveNowMs = Math.max(nowMs, existing.lastRefillMs);
      const elapsedMs = Math.max(0, effectiveNowMs - existing.lastRefillMs);
      const refillTokens = elapsedMs * refillPerMs;
      const nextBucket: RateBucketState = {
        tokens: Math.min(capacity, existing.tokens + refillTokens),
        lastRefillMs: effectiveNowMs,
      };
      if (nextBucket.tokens < 1) {
        return null;
      }
      nextBucket.tokens -= 1;
      return nextBucket;
    }
    const nextBucket: RateBucketState = { tokens: capacity, lastRefillMs: nowMs };
    if (nextBucket.tokens < 1) {
      return null;
    }
    nextBucket.tokens -= 1;
    return nextBucket;
  }

  #pruneBuckets(nowMs: number): void {
    const ttlMs = Math.max(1, this.#config.rateBucketTtlMs);
    for (const [key, bucket] of Array.from(this.#connectionRateBuckets.entries())) {
      if (nowMs - bucket.lastRefillMs > ttlMs) {
        this.#connectionRateBuckets.delete(key);
      }
    }
    for (const [key, bucket] of Array.from(this.#playerRateBuckets.entries())) {
      if (nowMs - bucket.lastRefillMs > ttlMs) {
        this.#playerRateBuckets.delete(key);
      }
    }
    this.#pruneBucketMap(this.#connectionRateBuckets);
    this.#pruneBucketMap(this.#playerRateBuckets);
  }

  #pruneBucketMap(buckets: Map<string, RateBucketState>): void {
    const maxBuckets = Math.max(1, this.#config.maxRateBuckets);
    if (buckets.size <= maxBuckets) {
      return;
    }
    const sorted = Array.from(buckets.entries()).sort((left, right) => left[1].lastRefillMs - right[1].lastRefillMs);
    while (buckets.size > maxBuckets) {
      const oldest = sorted.shift();
      if (!oldest) {
        break;
      }
      buckets.delete(oldest[0]);
    }
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
    maxRateBuckets: 256,
    rateBucketTtlMs: 2_000,
    ...overrides,
  };
}

export function createRoomAdmissionCommandId(playerId: PlayerId, actorSequence: number): CommandId {
  return createCommandIdValue(playerId, actorSequence);
}
