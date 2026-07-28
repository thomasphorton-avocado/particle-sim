export const DEFAULT_PUBLICATION_HZ = 60;

export interface PublicationCadenceConfig {
  publicationHz?: number;
  maxCatchUpTicks?: number;
}

export interface PublicationCadenceDecision {
  shouldPublish: boolean;
  reason: "none" | "due" | "catch-up" | "critical";
  revisionGap: number;
  publicationIntervalTicks: number;
}

export class PublicationCadence {
  #publicationHz: number;
  #maxCatchUpTicks: number;
  #lastPublishedRevision: number;
  #lastObservedRevision: number;

  constructor(config: PublicationCadenceConfig = {}) {
    const publicationHz = Number(config.publicationHz ?? DEFAULT_PUBLICATION_HZ);
    if (!Number.isFinite(publicationHz) || publicationHz <= 0) {
      throw new TypeError("publicationHz must be a positive finite number");
    }
    this.#publicationHz = publicationHz;
    this.#maxCatchUpTicks = Math.max(0, Math.floor(config.maxCatchUpTicks ?? 1));
    this.#lastPublishedRevision = 0;
    this.#lastObservedRevision = 0;
  }

  get publicationHz(): number {
    return this.#publicationHz;
  }

  get publicationIntervalTicks(): number {
    return Math.max(1, Math.round(60 / this.#publicationHz));
  }

  get lastPublishedRevision(): number {
    return this.#lastPublishedRevision;
  }

  get lastObservedRevision(): number {
    return this.#lastObservedRevision;
  }

  reset(initialRevision = 0): void {
    this.#lastPublishedRevision = initialRevision;
    this.#lastObservedRevision = initialRevision;
  }

  observe(nextRevision: number, options: { force?: boolean; critical?: boolean } = {}): PublicationCadenceDecision {
    this.#lastObservedRevision = nextRevision;
    const revisionGap = Math.max(0, nextRevision - this.#lastPublishedRevision);
    const publicationIntervalTicks = this.publicationIntervalTicks;
    const due = revisionGap >= publicationIntervalTicks;
    const catchUp = revisionGap >= publicationIntervalTicks + this.#maxCatchUpTicks;
    const shouldPublish = Boolean(options.force || options.critical || due || catchUp);
    return {
      shouldPublish,
      reason: options.force || options.critical
        ? "critical"
        : catchUp
          ? "catch-up"
          : due
            ? "due"
            : "none",
      revisionGap,
      publicationIntervalTicks,
    };
  }

  markPublished(revision: number): void {
    this.#lastPublishedRevision = revision;
    this.#lastObservedRevision = revision;
  }
}
