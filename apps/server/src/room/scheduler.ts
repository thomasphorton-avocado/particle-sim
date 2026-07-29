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

export class DeadlineScheduler implements RoomScheduler {
  #clock: Clock;
  #intervalMs: number;
  #maxCatchUpTicks: number;
  #active: boolean;
  #running: boolean;
  #callback: (() => void) | null;
  #nextDeadlineMs: number | null;
  #lastDelayKind: "none" | "catch-up" | "excessive";

  constructor(clock: Clock, intervalMs: number, maxCatchUpTicks: number) {
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
    this.#callback = callback;
    this.#active = true;
    const now = this.#clock.nowMs();
    this.#nextDeadlineMs = now + this.#intervalMs;
    this.#lastDelayKind = "none";
  }

  stop(): void {
    this.#active = false;
    this.#callback = null;
  }

  drive(nowMs = this.#clock.nowMs()): number {
    if (!this.#active || this.#running || this.#callback === null) {
      return 0;
    }
    this.#running = true;
    try {
      const deadline = this.#nextDeadlineMs ?? nowMs + this.#intervalMs;
      const latenessMs = nowMs - deadline;
      const missedTicks = Math.max(0, Math.floor(latenessMs / this.#intervalMs));
      const catchUpTicks = missedTicks <= this.#maxCatchUpTicks ? missedTicks : this.#maxCatchUpTicks;
      const ticksToRun = missedTicks === 0 ? 1 : Math.min(this.#maxCatchUpTicks + 1, catchUpTicks + 1);
      if (ticksToRun > 1) {
        this.#lastDelayKind = missedTicks > this.#maxCatchUpTicks ? "excessive" : "catch-up";
      } else {
        this.#lastDelayKind = "none";
      }
      for (let index = 0; index < ticksToRun; index += 1) {
        this.#callback();
      }
      this.#nextDeadlineMs = deadline + ticksToRun * this.#intervalMs;
      return ticksToRun;
    } finally {
      this.#running = false;
    }
  }
}
