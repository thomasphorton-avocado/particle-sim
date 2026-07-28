import { advanceWorldTick, type PlayerInputState } from "./gameplay.js";
import { createCommandEnvelope, getNextActorSequence, processPendingCommands, type CommandResult, type GameplayCommand } from "./commands.js";
import { type PlayerId } from "./ids.js";
import { type WorldState, createDefaultCommandLedger, createDefaultPlayerState, createDefaultWorldState } from "./world-state.js";
import { createPlayerId } from "./ids.js";
import { applyWorldDeltaToSnapshotState, cloneDeltaValue, cloneWorldDelta, cloneWorldSnapshot, createWorldDelta, createWorldSnapshot, restoreWorldState, type WorldDelta, type WorldSnapshot } from "./replication.js";
import type { DirtyCellEntry } from "./dirty-journal.js";
import { DEFAULT_PUBLICATION_HZ, PublicationCadence, type PublicationCadenceConfig } from "./publication-cadence.js";

export type DayNightPreset = "morning" | "day" | "dusk" | "night";

export interface TransportClientState {
  revision: number;
  snapshot: WorldSnapshot | null;
  delta: WorldDelta | null;
  clientWorld: WorldState;
  lastCommandResults: ReadonlyArray<CommandResult>;
}

export type TransportListener = (state: TransportClientState) => void;

export interface LocalTransportEditorCapability {
  replaceWorld(world: WorldState): void;
  mutateWorld(mutator: (world: WorldState) => void): void;
}

export interface LocalTransportSession {
  transport: LocalTransport;
  editor: LocalTransportEditorCapability;
}

export interface LocalTransportOptions {
  publicationHz?: number;
  publicationCadence?: PublicationCadenceConfig;
}

interface TransportReplica {
  snapshot: WorldSnapshot;
  canonicalSnapshot: WorldSnapshot | null;
  delta: WorldDelta | null;
  revision: number;
  clientWorld: WorldState;
  lastCommandResults: CommandResult[];
}

interface TransportSubscriber {
  listener: TransportListener;
  replica: TransportReplica;
}

function cloneTransportWorld(world: WorldState): WorldState {
  const cloned = cloneWorldState(world);
  cloned.commandInbox = [];
  cloned.commandLedger = createDefaultCommandLedger();
  cloned.nextAuthorityOrder = 1;
  return cloned;
}

export class LocalTransport {
  #world: WorldState;
  #ownerPlayerId: PlayerId;
  #replica: TransportReplica;
  #subscribers: TransportSubscriber[];
  #pendingCommandResults: CommandResult[];
  #lastCommandResults: CommandResult[];
  #publishedCellRevisions: Map<number, number>;
  #editorCapability: LocalTransportEditorCapability;
  #publishInProgress: boolean;
  #publishQueued: boolean;
  #initialSyncFailed: boolean;
  #publicationCadence: PublicationCadence;
  #publicationSubscriberSnapshot: TransportSubscriber[] | null;

  constructor(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1"), options: LocalTransportOptions = {}) {
    this.#world = cloneTransportWorld(world);
    this.#ownerPlayerId = ownerPlayerId;
    this.#prepareWorld();
    this.#replica = this.#createReplica(createWorldSnapshot(this.#world));
    this.#subscribers = [];
    this.#pendingCommandResults = [];
    this.#lastCommandResults = [];
    this.#publishedCellRevisions = new Map<number, number>();
    this.#editorCapability = this.#createEditorCapability();
    this.#publishInProgress = false;
    this.#publishQueued = false;
    this.#initialSyncFailed = false;
    this.#publicationSubscriberSnapshot = null;
    this.#publicationCadence = new PublicationCadence(options.publicationCadence ?? {
      publicationHz: options.publicationHz ?? DEFAULT_PUBLICATION_HZ,
    });
    this.#publicationCadence.reset(this.#getAuthorityRevision(this.#world));
  }

  subscribe(listener: TransportListener): () => void {
    const subscriber: TransportSubscriber = {
      listener,
      replica: this.#createReplica(this.#getSubscriptionSnapshot()),
    };
    const initialSubscriberSnapshot = this.#subscribers.slice();
    const unsubscribe = () => {
      this.#subscribers = this.#subscribers.filter((entry) => entry.listener !== listener);
    };
    this.#subscribers.push(subscriber);
    if (!this.#initialSyncFailed) {
      queueMicrotask(() => {
        if (this.#initialSyncFailed) {
          return;
        }
        this.#publicationSubscriberSnapshot = initialSubscriberSnapshot;
        try {
          subscriber.listener(this.#buildClientState(subscriber.replica, true));
        } catch (error) {
          if (this.#isInitialSyncUnsubscribeError(error)) {
            unsubscribe();
          }
          this.#initialSyncFailed = true;
        } finally {
          this.#publicationSubscriberSnapshot = null;
        }
      });
    }
    return unsubscribe;
  }

  getClientWorld(): WorldState {
    return cloneWorldState(this.#replica.clientWorld);
  }

  getClientSnapshot(): WorldSnapshot {
    return this.#materializeSnapshot(this.#replica);
  }

  getClientDelta(): WorldDelta | null {
    return this.#replica.delta ? cloneWorldDelta(this.#replica.delta) : null;
  }

  getClientState(): TransportClientState {
    return this.#buildClientState(this.#replica, true);
  }

  getLastCommandResults(): ReadonlyArray<CommandResult> {
    return this.#replica.lastCommandResults.map((result) => cloneCommandResult(result));
  }

  enqueueCommand(command: GameplayCommand): void {
    const actorId = this.#ownerPlayerId;
    const envelope = createCommandEnvelope(actorId, getNextActorSequence(this.#world, actorId), this.#world.tick, command);
    this.#world.commandInbox.push(envelope);
  }

  advanceTick(input?: PlayerInputState): void {
    const previousPaused = this.#world.paused;
    const results = processPendingCommands(this.#world);
    if (results.length > 0) {
      const clonedResults = results.map((result) => cloneCommandResult(result));
      this.#pendingCommandResults.push(...clonedResults);
      this.#lastCommandResults.push(...clonedResults);
      if (this.#pendingCommandResults.length > 256) {
        this.#pendingCommandResults = this.#pendingCommandResults.slice(-256);
      }
      if (this.#lastCommandResults.length > 256) {
        this.#lastCommandResults = this.#lastCommandResults.slice(-256);
      }
    }
    const shouldPublishImmediately = this.#pendingCommandResults.length > 0 || previousPaused !== this.#world.paused;
    if (this.#world.paused) {
      clearPendingInputs(this.#world);
      const cadenceDecision = this.#publicationCadence.observe(this.#getAuthorityRevision(this.#world), { force: shouldPublishImmediately });
      const shouldPublish = cadenceDecision.shouldPublish || shouldPublishImmediately;
      if (shouldPublish) {
        this.#publish({ force: shouldPublishImmediately, materializeSnapshot: false });
      }
      return;
    }
    const resolvedInputs = buildResolvedInputs(this.#world, this.#ownerPlayerId, input);
    advanceWorldTick(this.#world, resolvedInputs);
    const cadenceDecision = this.#publicationCadence.observe(this.#getAuthorityRevision(this.#world), { force: shouldPublishImmediately });
    const shouldPublish = cadenceDecision.shouldPublish || shouldPublishImmediately;
    if (shouldPublish) {
      this.#publish({ force: shouldPublishImmediately, materializeSnapshot: false });
    }
  }

  #getAuthorityRevision(world: WorldState): number {
    return Math.max(world.tick, world.worldRevision);
  }

  #isInitialSyncUnsubscribeError(error: unknown): boolean {
    return error instanceof TypeError && typeof error.message === "string" && error.message.includes("is not a function");
  }

  #isReplicaResyncError(error: unknown): boolean {
    return error instanceof TypeError && typeof error.message === "string" && error.message.includes("does not match the checkpoint");
  }

  #prepareWorld(): void {
    if (this.#world.ownerPlayerId === null) {
      this.#world.ownerPlayerId = this.#ownerPlayerId;
    }
    if (!this.#world.players[this.#ownerPlayerId]) {
      this.#world.players[this.#ownerPlayerId] = createDefaultPlayerState(this.#ownerPlayerId);
    }
  }

  #replaceWorldForEditor(world: WorldState): void {
    this.#world = cloneTransportWorld(world);
    this.#prepareWorld();
    this.#publishedCellRevisions.clear();
    this.#pendingCommandResults = [];
    this.#lastCommandResults = [];
    this.#publicationCadence.reset(this.#getAuthorityRevision(this.#world));
    this.#publish({ force: true, materializeSnapshot: true });
  }

  #createEditorCapability(): LocalTransportEditorCapability {
    return {
      replaceWorld: (world: WorldState) => this.#replaceWorldForEditor(world),
      mutateWorld: (mutator: (world: WorldState) => void) => {
        const world = cloneWorldState(this.#world);
        mutator(world);
        this.#replaceWorldForEditor(world);
      },
    };
  }

  #createReplica(snapshot: WorldSnapshot): TransportReplica {
    const canonicalSnapshot = cloneWorldSnapshot(snapshot);
    return {
      snapshot: cloneWorldSnapshot(canonicalSnapshot),
      canonicalSnapshot: cloneWorldSnapshot(canonicalSnapshot),
      delta: null,
      revision: canonicalSnapshot.worldRevision,
      clientWorld: restoreWorldState(canonicalSnapshot),
      lastCommandResults: [],
    };
  }

  #buildClientState(replica: TransportReplica, materializeSnapshot = false): TransportClientState {
    const snapshot = materializeSnapshot
      ? this.#materializeSnapshot(replica)
      : (replica.canonicalSnapshot
        ? cloneWorldSnapshot(replica.canonicalSnapshot)
        : null);
    return {
      revision: replica.revision,
      snapshot,
      delta: replica.delta ? cloneWorldDelta(replica.delta) : null,
      clientWorld: cloneWorldState(replica.clientWorld),
      lastCommandResults: replica.lastCommandResults.map((result) => cloneCommandResult(result)),
    };
  }

  #materializeSnapshot(replica: TransportReplica): WorldSnapshot {
    const snapshot = createWorldSnapshot(replica.clientWorld);
    replica.snapshot = cloneWorldSnapshot(snapshot);
    replica.canonicalSnapshot = cloneWorldSnapshot(snapshot);
    return cloneWorldSnapshot(snapshot);
  }

  #getSubscriptionSnapshot(): WorldSnapshot {
    if (this.#replica.canonicalSnapshot) {
      return cloneWorldSnapshot(this.#replica.canonicalSnapshot);
    }
    return this.#materializeSnapshot(this.#replica);
  }

  #publish(options: { force?: boolean; materializeSnapshot?: boolean; throwOnError?: boolean } = {}): void {
    if (this.#publishInProgress) {
      this.#publishQueued = true;
      return;
    }

    this.#publishInProgress = true;
    const errors: unknown[] = [];
    try {
      let shouldRun = true;
      while (shouldRun) {
        shouldRun = false;
        const startRevision = this.#getAuthorityRevision(this.#world);
        const subscribers = this.#publicationSubscriberSnapshot ?? this.#subscribers.slice();
        const iterationErrors = this.#publishOnce(options, subscribers);
        errors.push(...iterationErrors);
        if (this.#publishQueued) {
          const endRevision = this.#getAuthorityRevision(this.#world);
          const hasPendingResults = this.#pendingCommandResults.length > 0;
          const hasPendingCells = this.#world.grid.dirtyCells.readPending().length > 0;
          this.#publishQueued = false;
          shouldRun = Boolean(options.force || hasPendingResults || hasPendingCells || endRevision !== startRevision);
        }
      }
    } finally {
      this.#publishInProgress = false;
    }

    if (errors.length > 0 && options.throwOnError !== false) {
      const message = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
      throw new AggregateError(errors, `LocalTransport subscriber publication failed: ${message}`);
    }
  }

  #publishOnce(options: { force?: boolean; materializeSnapshot?: boolean } = {}, subscribers: TransportSubscriber[] = this.#subscribers.slice()): unknown[] {
    const pendingCommandResults = this.#pendingCommandResults;
    this.#pendingCommandResults = [];
    const pendingCellEntries = this.#world.grid.dirtyCells.capturePending();
    const nextDelta = this.#buildDelta(this.#replica.snapshot, pendingCellEntries);
    const lastCommandResults = pendingCommandResults.map((result) => cloneCommandResult(result));
    const shouldPublish = Boolean(options.force || lastCommandResults.length > 0 || nextDelta !== null);
    if (!shouldPublish) {
      this.#replica.lastCommandResults = lastCommandResults;
      return [];
    }
    const authorityRevision = this.#world.worldRevision;
    const publicationRevision = this.#getAuthorityRevision(this.#world);
    const effectiveRevision = Boolean(options.force || lastCommandResults.length > 0) ? authorityRevision : publicationRevision;
    const forceResync = Boolean(options.materializeSnapshot || (options.force && nextDelta === null));
    this.#commitPublication(nextDelta, lastCommandResults, pendingCellEntries, authorityRevision, effectiveRevision, { forceResync, materializeSnapshot: options.materializeSnapshot });
    this.#publicationCadence.markPublished(publicationRevision);

    const errors: unknown[] = [];
    for (const subscriber of subscribers) {
      if (!this.#subscribers.includes(subscriber)) {
        continue;
      }
      try {
        if (nextDelta && subscriber.replica.snapshot.worldRevision !== nextDelta.baseRevision) {
          this.#resyncReplicaToAuthority(subscriber.replica, authorityRevision, effectiveRevision);
        } else {
          this.#updateReplica(subscriber.replica, nextDelta, authorityRevision, effectiveRevision, { forceResync });
        }
        subscriber.replica.lastCommandResults = lastCommandResults;
        subscriber.listener(this.#buildClientState(subscriber.replica, Boolean(options.materializeSnapshot)));
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  }

  #commitPublication(nextDelta: WorldDelta | null, lastCommandResults: CommandResult[], _pendingCellEntries: DirtyCellEntry[], authorityRevision: number, replicaRevision: number, options: { forceResync?: boolean; materializeSnapshot?: boolean } = {}): void {
    this.#updateReplica(this.#replica, nextDelta, authorityRevision, replicaRevision, options);
    this.#replica.lastCommandResults = lastCommandResults;
    if (nextDelta !== null) {
      for (const cellDelta of nextDelta.cells) {
        this.#publishedCellRevisions.set(cellDelta.index, cellDelta.revision);
      }
    }
  }

  #buildDelta(previousSnapshot: WorldSnapshot, dirtyCellEntries: DirtyCellEntry[]): WorldDelta | null {
    return createWorldDelta(previousSnapshot, this.#world, {
      dirtyCellEntries,
      publishedCellRevisions: this.#publishedCellRevisions,
    });
  }

  #updateReplica(replica: TransportReplica, delta: WorldDelta | null, authorityRevision: number, replicaRevision: number, options: { forceResync?: boolean; materializeSnapshot?: boolean } = {}): void {
    if (options.forceResync) {
      this.#syncReplicaFromAuthority(replica, authorityRevision, replicaRevision);
      return;
    }
    replica.delta = delta ? cloneWorldDelta(delta) : null;
    if (!delta) {
      replica.snapshot.checksum = "";
      replica.canonicalSnapshot = null;
      replica.revision = replicaRevision;
      return;
    }
    try {
      applyWorldDeltaToSnapshotState(replica.snapshot.worldState, delta);
    } catch (error) {
      if (this.#isReplicaResyncError(error)) {
        this.#resyncReplicaToAuthority(replica, authorityRevision, replicaRevision);
        return;
      }
      throw error;
    }
    replica.snapshot.worldRevision = authorityRevision;
    replica.snapshot.worldState.worldRevision = authorityRevision;
    replica.snapshot.checksum = "";
    replica.revision = replicaRevision;
    replica.canonicalSnapshot = null;
    this.#applyDeltaToWorld(replica.clientWorld, delta, authorityRevision);
  }

  #resyncReplicaToAuthority(replica: TransportReplica, authorityRevision: number, replicaRevision: number): void {
    this.#syncReplicaFromAuthority(replica, authorityRevision, replicaRevision);
  }

  #syncReplicaFromAuthority(replica: TransportReplica, authorityRevision: number, replicaRevision: number): void {
    const snapshot = createWorldSnapshot(this.#world);
    replica.snapshot = cloneWorldSnapshot(snapshot);
    replica.canonicalSnapshot = cloneWorldSnapshot(snapshot);
    replica.delta = null;
    replica.revision = replicaRevision;
    replica.clientWorld = restoreWorldState(snapshot);
    replica.snapshot.worldRevision = authorityRevision;
    replica.snapshot.worldState.worldRevision = authorityRevision;
    replica.snapshot.checksum = "";
  }

  #applyDeltaToWorld(world: WorldState, delta: WorldDelta, authorityRevision: number): void {
    for (const cellDelta of delta.cells) {
      world.grid.applyCellState(cellDelta.index, cellDelta.materialId, cellDelta.shade, cellDelta.auxiliary, cellDelta.objectId as Parameters<typeof world.grid.applyCellState>[4], cellDelta.revision);
    }
    for (const playerDelta of delta.players) {
      if (playerDelta.state === null) {
        delete world.players[playerDelta.playerId];
        continue;
      }
      world.players[playerDelta.playerId] = cloneDeltaValue(playerDelta.state) as typeof world.players[string];
    }
    for (const fallingObjectDelta of delta.fallingObjects) {
      if (fallingObjectDelta.state === null) {
        delete world.fallingObjects[fallingObjectDelta.objectId];
        continue;
      }
      world.fallingObjects[fallingObjectDelta.objectId] = cloneDeltaValue(fallingObjectDelta.state) as typeof world.fallingObjects[string];
    }
    for (const metadataDelta of delta.metadata) {
      this.#applyMetadataDelta(world, metadataDelta, authorityRevision);
    }
    world.worldRevision = authorityRevision;
  }

  #applyMetadataDelta(world: WorldState, delta: WorldDelta["metadata"][number], authorityRevision: number): void {
    switch (delta.field) {
      case "roomId":
        world.roomId = delta.value as typeof world.roomId;
        return;
      case "tick":
        world.tick = delta.value as typeof world.tick;
        return;
      case "paused":
        world.paused = delta.value as typeof world.paused;
        return;
      case "time":
        world.time = cloneDeltaValue(delta.value) as typeof world.time;
        return;
      case "weather":
        world.weather = cloneDeltaValue(delta.value) as typeof world.weather;
        return;
      case "random":
        world.random = cloneDeltaValue(delta.value) as typeof world.random;
        return;
      case "ownerPlayerId":
        world.ownerPlayerId = cloneDeltaValue(delta.value) as typeof world.ownerPlayerId;
        return;
      case "worldRevision":
        world.worldRevision = authorityRevision;
        return;
      case "nextAuthorityOrder":
        world.nextAuthorityOrder = delta.value as typeof world.nextAuthorityOrder;
        return;
      case "nextPlayerOrdinal":
        world.nextPlayerOrdinal = delta.value as typeof world.nextPlayerOrdinal;
        return;
      case "nextObjectOrdinal":
        world.nextObjectOrdinal = delta.value as typeof world.nextObjectOrdinal;
        return;
      case "commandLedger":
        world.commandLedger = cloneDeltaValue(delta.value) as typeof world.commandLedger;
        return;
    }
  }

  static createSession(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1"), options: LocalTransportOptions = {}): LocalTransportSession {
    const transport = new LocalTransport(world, ownerPlayerId, options);
    return {
      transport,
      editor: transport.#editorCapability,
    };
  }
}

export function createLocalTransportSession(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1"), options: LocalTransportOptions = {}): LocalTransportSession {
  return LocalTransport.createSession(world, ownerPlayerId, options);
}

function clearPendingInputs(world: WorldState): void {
  for (const player of Object.values(world.players)) {
    player.input.left = false;
    player.input.right = false;
    player.input.jumpHeld = false;
    player.input.crouchHeld = false;
    player.input.lookUpHeld = false;
    player.input.mineHeld = false;
  }
}

function buildResolvedInputs(world: WorldState, ownerPlayerId: PlayerId, input?: PlayerInputState): Record<string, PlayerInputState> {
  const initialState = input ?? world.players[ownerPlayerId]?.input;
  return {
    [ownerPlayerId]: normalizeInputState(initialState),
  };
}

function normalizeInputState(input?: PlayerInputState): PlayerInputState {
  if (!input) {
    return {
      left: false,
      right: false,
      jumpHeld: false,
      crouchHeld: false,
      lookUpHeld: false,
      mineHeld: false,
    };
  }
  return {
    left: Boolean(input.left),
    right: Boolean(input.right),
    jumpHeld: Boolean(input.jumpHeld),
    crouchHeld: Boolean(input.crouchHeld),
    lookUpHeld: Boolean(input.lookUpHeld),
    mineHeld: Boolean(input.mineHeld),
  };
}

function cloneWorldState(world: WorldState): WorldState {
  return restoreWorldState(createWorldSnapshot(world));
}

function cloneCommandResult(result: CommandResult): CommandResult {
  return JSON.parse(JSON.stringify(result));
}
