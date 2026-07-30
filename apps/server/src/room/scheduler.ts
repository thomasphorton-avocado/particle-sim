export interface Clock {
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export interface DeadlineSchedulerState {
  readonly active: boolean;
  readonly intervalMs: number;
  readonly maxCatchUpTicks: number;
  readonly nextDeadlineMs: number | null;
  readonly lastDelayKind: "none" | "catch-up" | "excessive";
}

export interface RoomScheduler {
  readonly state: DeadlineSchedulerState;
  start(callback: () => void): void;
  stop(): void;
  drive(nowMs?: number): number;
}

export interface DeadlineTimerDriver {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export class ManualDeadlineTimerDriver implements DeadlineTimerDriver {
  #nowMs: number;
  #nextId: number;
  #pending: Array<{ id: number; callback: () => void; dueAt: number }>;

  constructor(startMs = 0) {
    this.#nowMs = startMs;
    this.#nextId = 1;
    this.#pending = [];
  }

  get nowMs(): number {
    return this.#nowMs;
  }

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.push({ id, callback, dueAt: this.#nowMs + delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    if (typeof handle !== "number") {
      return;
    }
    this.#pending = this.#pending.filter((entry) => entry.id !== handle);
  }

  advanceBy(ms: number): void {
    this.#nowMs += ms;
    while (true) {
      const dueEntries = this.#pending.filter((entry) => entry.dueAt <= this.#nowMs).sort((left, right) => left.dueAt - right.dueAt);
      if (dueEntries.length === 0) {
        return;
      }
      this.#pending = this.#pending.filter((entry) => !dueEntries.some((candidate) => candidate.id === entry.id));
      for (const entry of dueEntries) {
        entry.callback();
      }
    }
  }
}

export class NodeDeadlineTimerDriver implements DeadlineTimerDriver {
  schedule(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  }

  cancel(handle: unknown): void {
    if (handle === null || handle === undefined) {
      return;
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

export class DeadlineScheduler implements RoomScheduler {
  #clock: Clock;
  #intervalMs: number;
  #maxCatchUpTicks: number;
  #active: boolean;
  #running: boolean;
  #callback: (() => void) | null;
  #nextDeadlineMs: number | null;
  #lastDelayKind: "none" | "catch-up" | "excessive";
  #timerHandle: unknown | null;
  #generation: number;
  #driver: DeadlineTimerDriver;

  constructor(clock: Clock, intervalMs: number, maxCatchUpTicks: number, driver: DeadlineTimerDriver = new ManualDeadlineTimerDriver()) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError("intervalMs must be a positive finite number");
    }
    if (!Number.isFinite(maxCatchUpTicks) || maxCatchUpTicks < 0) {
      throw new TypeError("maxCatchUpTicks must be >= 0");
    }
    this.#clock = clock;
    this.#intervalMs = intervalMs;
    this.#maxCatchUpTicks = maxCatchUpTicks;
    this.#active = false;
    this.#running = false;
    this.#callback = null;
    this.#nextDeadlineMs = null;
    this.#lastDelayKind = "none";
    this.#timerHandle = null;
    this.#generation = 0;
    this.#driver = driver;
  }

  get state(): DeadlineSchedulerState {
    return {
      active: this.#active,
      intervalMs: this.#intervalMs,
      maxCatchUpTicks: this.#maxCatchUpTicks,
      nextDeadlineMs: this.#nextDeadlineMs,
      lastDelayKind: this.#lastDelayKind,
    };
  }

  start(callback: () => void): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#callback = callback;
    this.#active = true;
    this.#nextDeadlineMs = this.#clock.nowMs() + this.#intervalMs;
    this.#lastDelayKind = "none";
    this.#cancelTimer();
    this.#scheduleNext(generation);
  }

  stop(): void {
    this.#generation += 1;
    this.#active = false;
    this.#callback = null;
    this.#cancelTimer();
    this.#nextDeadlineMs = null;
    this.#lastDelayKind = "none";
  }

  drive(nowMs = this.#clock.nowMs()): number {
    if (!this.#active || this.#running || this.#callback === null) {
      return 0;
    }

    const generation = this.#generation;
    this.#running = true;
    try {
      const deadline = this.#nextDeadlineMs ?? nowMs + this.#intervalMs;
      const latenessMs = Math.max(0, nowMs - deadline);
      const missedTicks = Math.max(0, Math.floor(latenessMs / this.#intervalMs));
      const ticksToRun = missedTicks === 0 ? 1 : Math.min(this.#maxCatchUpTicks + 1, missedTicks + 1);
      this.#lastDelayKind = missedTicks === 0 ? "none" : missedTicks > this.#maxCatchUpTicks ? "excessive" : "catch-up";

      let actualRuns = 0;
      for (let index = 0; index < ticksToRun; index += 1) {
        if (!this.#active || this.#callback === null || generation !== this.#generation) {
          break;
        }
        this.#callback();
        actualRuns += 1;
      }

      if (missedTicks > this.#maxCatchUpTicks) {
        this.#nextDeadlineMs = nowMs + this.#intervalMs;
      } else {
        this.#nextDeadlineMs = deadline + actualRuns * this.#intervalMs;
      }
      return actualRuns;
    } finally {
      this.#running = false;
    }
  }

  #scheduleNext(generation: number): void {
    if (!this.#active || this.#callback === null || generation !== this.#generation) {
      return;
    }
    this.#cancelTimer();
    const nowMs = this.#clock.nowMs();
    const deadline = this.#nextDeadlineMs ?? nowMs + this.#intervalMs;
    const delayMs = Math.max(0, deadline - nowMs);
    this.#timerHandle = this.#driver.schedule(() => {
      if (!this.#active || this.#callback === null || generation !== this.#generation) {
        return;
      }
      this.#runDueTicks(generation);
    }, delayMs);
  }

  #runDueTicks(generation: number): void {
    if (!this.#active || this.#callback === null || generation !== this.#generation) {
      return;
    }
    this.drive(this.#clock.nowMs());
    if (!this.#active || this.#callback === null || generation !== this.#generation) {
      return;
    }
    this.#scheduleNext(generation);
  }

  #cancelTimer(): void {
    if (this.#timerHandle !== null) {
      this.#driver.cancel(this.#timerHandle);
      this.#timerHandle = null;
    }
  }
}
