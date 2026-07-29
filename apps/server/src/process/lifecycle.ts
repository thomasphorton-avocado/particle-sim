export interface ProcessLifecycleState {
  readonly admissionOpen: boolean;
  readonly shuttingDown: boolean;
  readonly shutdownStartedAtMs: number | null;
}

export class ProcessLifecycle {
  #admissionOpen: boolean;
  #shuttingDown: boolean;
  #shutdownStartedAtMs: number | null;

  constructor(initialAdmissionOpen = true) {
    this.#admissionOpen = initialAdmissionOpen;
    this.#shuttingDown = false;
    this.#shutdownStartedAtMs = null;
  }

  get admissionOpen(): boolean {
    return this.#admissionOpen;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  get shutdownStartedAtMs(): number | null {
    return this.#shutdownStartedAtMs;
  }

  get ready(): boolean {
    return this.#admissionOpen && !this.#shuttingDown;
  }

  beginShutdown(nowMs: number): void {
    if (this.#shuttingDown) {
      return;
    }
    this.#admissionOpen = false;
    this.#shuttingDown = true;
    this.#shutdownStartedAtMs = nowMs;
  }

  getState(): ProcessLifecycleState {
    return {
      admissionOpen: this.#admissionOpen,
      shuttingDown: this.#shuttingDown,
      shutdownStartedAtMs: this.#shutdownStartedAtMs,
    };
  }
}
