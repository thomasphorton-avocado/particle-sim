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
}

class MemoryPublisher implements RoomPublisher {
  readonly publications: RoomPublication[] = [];

  publish(publication: RoomPublication): void {
    this.publications.push(publication);
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

  async shutdown(deadlineMs = 1000): Promise<void> {
    this.#lifecycle.beginShutdown(this.#clock.nowMs());
    const closeWait = Promise.allSettled(Array.from(this.#rooms.values()).map((room) => room.beginShutdown("server_shutdown")));
    this.#rooms.clear();

    if (deadlineMs <= 0) {
      await closeWait;
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
  }

  async cleanupIdleRooms(nowMs = this.#clock.nowMs()): Promise<Room[]> {
    if (!this.#idleCleanupPolicy) {
      return [];
    }
    const idleRooms: Room[] = [];
    for (const room of Array.from(this.#rooms.values())) {
      if (this.#idleCleanupPolicy(room, nowMs)) {
        idleRooms.push(room);
        await room.beginShutdown("idle_cleanup");
        this.#rooms.delete(room.roomId);
      }
    }
    return idleRooms;
  }
}
