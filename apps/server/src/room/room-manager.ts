import { createDefaultRoomId } from "../config.js";
import { AdmissionClosedError, RoomLimitError } from "../errors.js";
import { ProcessLifecycle } from "../process/lifecycle.js";
import { DeadlineScheduler, NodeDeadlineTimerDriver, SystemClock, type Clock, type RoomScheduler } from "./scheduler.js";
import { Room, type RoomConfig } from "./room.js";
import type { RoomId } from "@particle-sim/shared";
import type { RoomPublication, RoomPublisher, RoomTransportHooks } from "./types.js";
import { RoomShutdownTimeoutError } from "../errors.js";

export interface RoomTimerAdapter {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RoomManagerDependencies {
  readonly clock?: Clock;
  readonly schedulerFactory?: (clock: Clock, intervalMs: number, maxCatchUpTicks: number) => RoomScheduler;
  readonly publisher?: RoomPublisher;
  readonly hooks?: RoomTransportHooks;
  readonly lifecycle?: ProcessLifecycle;
  readonly idleCleanupPolicy?: (room: Room, nowMs: number) => boolean;
  readonly timing?: RoomTimerAdapter;
}

export interface RoomManagerConfig {
  readonly maxRooms: number;
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly tickHz: number;
  readonly maxCatchUpTicks: number;
  readonly idleCleanupThresholdMs: number;
  readonly reconnectTimeoutMs?: number;
  readonly reconnectTombstoneLimit?: number;
}

export class MemoryPublisher implements RoomPublisher {
  readonly publications: RoomPublication[] = [];
  #sizeBytes = 0;
  #maxPublications = 64;
  #maxBytes = 1_048_576;

  publish(publication: RoomPublication): void {
    const payload = JSON.stringify(publication);
    const payloadBytes = payload.length;
    this.publications.push(publication);
    this.#sizeBytes += payloadBytes;
    while (this.publications.length > this.#maxPublications || this.#sizeBytes > this.#maxBytes) {
      const removed = this.publications.shift();
      if (!removed) {
        break;
      }
      this.#sizeBytes -= JSON.stringify(removed).length;
    }
  }
}

export class RoomManager {
  #config: RoomManagerConfig;
  #lifecycle: ProcessLifecycle;
  #clock: Clock;
  #schedulerFactory: (clock: Clock, intervalMs: number, maxCatchUpTicks: number) => RoomScheduler;
  #publisher: RoomPublisher;
  #hooks?: RoomTransportHooks;
  #idleCleanupPolicy?: (room: Room, nowMs: number) => boolean;
  #timing: RoomTimerAdapter;
  #rooms: Map<string, Room>;
  #nextRoomOrdinal: number;
  #shutdownPromise: Promise<void> | null;

  constructor(config: RoomManagerConfig, dependencies: RoomManagerDependencies = {}) {
    this.#config = config;
    this.#lifecycle = dependencies.lifecycle ?? new ProcessLifecycle(true);
    this.#clock = dependencies.clock ?? new SystemClock();
    this.#schedulerFactory = dependencies.schedulerFactory ?? ((clock, intervalMs, maxCatchUpTicks) => new DeadlineScheduler(clock, intervalMs, maxCatchUpTicks, new NodeDeadlineTimerDriver()));
    this.#publisher = dependencies.publisher ?? new MemoryPublisher();
    this.#hooks = dependencies.hooks;
    this.#idleCleanupPolicy = dependencies.idleCleanupPolicy;
    this.#timing = dependencies.timing ?? {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    };
    this.#rooms = new Map();
    this.#nextRoomOrdinal = 1;
    this.#shutdownPromise = null;
  }

  get lifecycle(): ProcessLifecycle {
    return this.#lifecycle;
  }

  get rooms(): readonly Room[] {
    return Array.from(this.#rooms.values());
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  async createRoom(): Promise<Room> {
    if (!this.#lifecycle.ready) {
      throw new AdmissionClosedError();
    }
    if (this.#rooms.size >= this.#config.maxRooms) {
      throw new RoomLimitError();
    }

    const roomId = createDefaultRoomId(this.#nextRoomOrdinal) as RoomId;
    this.#nextRoomOrdinal += 1;

    const roomConfig: RoomConfig = {
      roomId,
      minCapacity: this.#config.minCapacity,
      maxCapacity: this.#config.maxCapacity,
      tickHz: this.#config.tickHz,
      maxCatchUpTicks: this.#config.maxCatchUpTicks,
      idleCleanupThresholdMs: this.#config.idleCleanupThresholdMs,
      reconnectTimeoutMs: this.#config.reconnectTimeoutMs,
      reconnectTombstoneLimit: this.#config.reconnectTombstoneLimit,
    };

    const room = new Room(roomConfig, {
      clock: this.#clock,
      scheduler: this.#schedulerFactory(this.#clock, 1000 / this.#config.tickHz, this.#config.maxCatchUpTicks),
      publisher: this.#publisher,
      hooks: this.#hooks,
    });
    this.#rooms.set(room.roomId, room);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.#rooms.get(roomId);
  }

  shutdown(deadlineMs = 1000): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }

    this.#shutdownPromise = (async () => {
      this.#lifecycle.beginShutdown(this.#clock.nowMs());
      const rooms = Array.from(this.#rooms.values());
      this.#rooms.clear();
      const closeWait = Promise.allSettled(rooms.map((room) => room.beginShutdown("server_shutdown")));

      if (deadlineMs <= 0) {
        const results = await closeWait;
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join("; "));
        }
        return;
      }

      let timedOut = false;
      let timeoutHandle: unknown | null = null;
      await new Promise<void>((resolve) => {
        timeoutHandle = this.#timing.setTimeout(() => {
          timedOut = true;
          this.#timing.clearTimeout(timeoutHandle);
          resolve();
        }, deadlineMs);

        const finish = () => {
          this.#timing.clearTimeout(timeoutHandle);
          resolve();
        };

        void closeWait.then(finish, finish);
      });

      if (timedOut) {
        throw new RoomShutdownTimeoutError();
      }

      const results = await closeWait;
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join("; "));
      }
    })();

    return this.#shutdownPromise;
  }

  async cleanupIdleRooms(nowMs = this.#clock.nowMs()): Promise<Room[]> {
    if (!this.#idleCleanupPolicy) {
      return [];
    }
    const idleRooms: Room[] = [];
    for (const room of Array.from(this.#rooms.values())) {
      if (this.#idleCleanupPolicy(room, nowMs)) {
        idleRooms.push(room);
        try {
          await room.beginShutdown("idle_cleanup");
        } finally {
          this.#rooms.delete(room.roomId);
        }
      }
    }
    return idleRooms;
  }
}
