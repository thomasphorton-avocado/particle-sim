import { advanceWorldTick, DAY_NIGHT_CYCLE_TICKS, type PlayerInputState } from "./gameplay.js";
import { createCommandEnvelope, processPendingCommands, type CommandResult, type GameplayCommand } from "./commands.js";
import { type PlayerId } from "./ids.js";
import { type WorldState, createDefaultCommandLedger, createDefaultPlayerState, createDefaultWorldState } from "./world-state.js";
import { createPlayerId } from "./ids.js";
import { applyWorldDeltaToSnapshotStateFast, cloneDeltaValue, cloneWorldDelta, cloneWorldSnapshot, cloneWorldState as cloneWorldStateFromReplication, createCommandLedgerDelta, createWorldDelta, createWorldSnapshot, restoreWorldState, type WorldDelta, type WorldSnapshot } from "./replication.js";
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
  initialSyncPending: boolean;
}

interface PublicationGenerationState {
  generation: number;
  commandResults: CommandResult[];
  dirtyCells: DirtyCellEntry[];
}

interface PublicationIterationState {
  generation: number;
  authorityWorld: WorldState;
  commandResults: CommandResult[];
  dirtyCells: DirtyCellEntry[];
  pendingGenerations: PublicationGenerationState[];
}

interface PublicationOptions {
  force?: boolean;
  materializeSnapshot?: boolean;
  publishResults?: boolean;
  throwOnError?: boolean;
}

interface PublicationRequest {
  generation: number;
  options: PublicationOptions;
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
  #lastCommandResults: CommandResult[];
  #pendingPublicationGenerations: PublicationGenerationState[];
  #nextActorSequenceByPlayer: Map<PlayerId, number>;
  #publishedCellRevisions: Map<number, number>;
  #editorCapability: LocalTransportEditorCapability;
  #publishInProgress: boolean;
  #publicationRequests: PublicationRequest[];
  #advanceInProgress: boolean;
  #pendingAdvanceInputs: Array<PlayerInputState | undefined>;
  #notificationDepth: number;
  #publicationCadence: PublicationCadence;
  #publicationGeneration: number;

  constructor(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1"), options: LocalTransportOptions = {}) {
    this.#world = cloneTransportWorld(world);
    this.#ownerPlayerId = ownerPlayerId;
    this.#prepareWorld();
    this.#replica = this.#createReplica(createWorldSnapshot(this.#world));
    this.#subscribers = [];
    this.#lastCommandResults = [];
    this.#pendingPublicationGenerations = [];
    this.#nextActorSequenceByPlayer = new Map<PlayerId, number>();
    this.#nextActorSequenceByPlayer.set(this.#ownerPlayerId, (this.#world.commandLedger.actorHighWater[this.#ownerPlayerId] ?? 0) + 1);
    this.#publishedCellRevisions = new Map<number, number>();
    this.#editorCapability = this.#createEditorCapability();
    this.#publishInProgress = false;
    this.#publicationRequests = [];
    this.#advanceInProgress = false;
    this.#pendingAdvanceInputs = [];
    this.#notificationDepth = 0;
    this.#publicationGeneration = 0;
    this.#publicationCadence = new PublicationCadence(options.publicationCadence ?? {
      publicationHz: options.publicationHz ?? DEFAULT_PUBLICATION_HZ,
    });
    this.#publicationCadence.reset(this.#getAuthorityRevision(this.#world));
  }

  subscribe(listener: TransportListener): () => void {
    const subscriber: TransportSubscriber = {
      listener,
      replica: this.#createReplica(this.#getSubscriptionSnapshot()),
      initialSyncPending: true,
    };
    const unsubscribe = () => {
      subscriber.initialSyncPending = false;
      this.#subscribers = this.#subscribers.filter((entry) => entry !== subscriber);
    };
    this.#subscribers.push(subscriber);
    queueMicrotask(() => {
      if (!subscriber.initialSyncPending || !this.#subscribers.includes(subscriber)) {
        return;
      }
      subscriber.initialSyncPending = false;
      try {
        this.#notifySubscriber(subscriber, this.#buildClientState(subscriber.replica, true));
      } catch (error) {
        if (this.#isInitialSyncUnsubscribeError(error)) {
          unsubscribe();
        }
      } finally {
        try {
          this.#drainAdvanceTicks();
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    });
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

  flushPublication(options: { materializeSnapshot?: boolean } = {}): void {
    let publicationError: unknown;
    try {
      this.#publish({ force: true, materializeSnapshot: options.materializeSnapshot ?? true });
    } catch (error) {
      publicationError = error;
    }
    let advanceError: unknown;
    try {
      this.#drainAdvanceTicks();
    } catch (error) {
      advanceError = error;
    }
    if (publicationError !== undefined && advanceError !== undefined) {
      throw new AggregateError([publicationError, advanceError], "LocalTransport flush failed");
    }
    if (publicationError !== undefined) {
      throw publicationError;
    }
    if (advanceError !== undefined) {
      throw advanceError;
    }
  }

  enqueueCommand(command: GameplayCommand): void {
    const actorId = this.#ownerPlayerId;
    const actorSequence = this.#getNextActorSequence(actorId);
    const envelope = createCommandEnvelope(actorId, actorSequence, this.#world.tick, command);
    this.#world.commandInbox.push(envelope);
  }

  advanceTick(input?: PlayerInputState): void {
    this.#pendingAdvanceInputs.push(input);
    this.#drainAdvanceTicks();
  }

  #drainAdvanceTicks(): void {
    if (this.#advanceInProgress || this.#notificationDepth > 0) {
      return;
    }
    this.#advanceInProgress = true;
    const errors: unknown[] = [];
    try {
      while (this.#pendingAdvanceInputs.length > 0) {
        const input = this.#pendingAdvanceInputs.shift();
        try {
          this.#advanceTickOnce(input);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.#advanceInProgress = false;
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "LocalTransport queued advances failed");
    }
  }

  #advanceTickOnce(input?: PlayerInputState): void {
    const previousPaused = this.#world.paused;
    const results = processPendingCommands(this.#world);
    if (results.length > 0) {
      this.#pendingPublicationGenerations.push({
        generation: this.#publicationGeneration + 1,
        commandResults: results,
        dirtyCells: [],
      });
      this.#publicationGeneration = this.#pendingPublicationGenerations.at(-1)?.generation ?? this.#publicationGeneration;
      this.#lastCommandResults.push(...results);
      if (this.#lastCommandResults.length > 256) {
        this.#lastCommandResults = this.#lastCommandResults.slice(-256);
      }
    }
    this.#replica.lastCommandResults = this.#lastCommandResults.slice();
    const shouldPublishImmediately = this.#shouldPublishImmediately(results, previousPaused);
    const shouldPublishResults = shouldPublishImmediately || results.some((result) => result.kind === "rejected");
    if (this.#world.paused) {
      clearPendingInputs(this.#world);
      const cadenceDecision = this.#publicationCadence.observe(this.#getAuthorityRevision(this.#world), { force: shouldPublishImmediately });
      const shouldPublish = cadenceDecision.shouldPublish || shouldPublishImmediately || shouldPublishResults;
      if (shouldPublish) {
        this.#publish({
          force: shouldPublish,
          publishResults: shouldPublishResults,
        });
      }
      return;
    }
    const resolvedInputs = buildResolvedInputs(this.#world, this.#ownerPlayerId, input);
    if (previousPaused && !this.#world.paused) {
      this.#advanceAuthorityTransition();
    } else {
      advanceWorldTick(this.#world, resolvedInputs);
    }
    const cadenceDecision = this.#publicationCadence.observe(this.#getAuthorityRevision(this.#world), { force: shouldPublishImmediately });
    const shouldPublish = cadenceDecision.shouldPublish || shouldPublishImmediately || shouldPublishResults;
    if (shouldPublish) {
      this.#publish({
        force: shouldPublish,
        publishResults: shouldPublishResults,
      });
    }
  }

  #advanceAuthorityTransition(): void {
    this.#world.time.dayNightTick = (this.#world.time.dayNightTick + 1) % DAY_NIGHT_CYCLE_TICKS;
    this.#world.time.dayNightCycle = this.#world.time.dayNightTick / DAY_NIGHT_CYCLE_TICKS;
    this.#world.tick += 1;
    this.#world.worldRevision += 1;
  }

  #getNextActorSequence(actorId: PlayerId): number {
    const nextSequence = this.#nextActorSequenceByPlayer.get(actorId) ?? ((this.#world.commandLedger.actorHighWater[actorId] ?? 0) + 1);
    this.#nextActorSequenceByPlayer.set(actorId, nextSequence + 1);
    return nextSequence;
  }

  #shouldPublishImmediately(results: CommandResult[], previousPaused: boolean): boolean {
    if (previousPaused !== this.#world.paused) {
      return true;
    }
    return results.some((result) => result.kind === "accepted" && (result.type === "pause_world" || result.type === "resume_world" || result.type === "set_time_preset"));
  }

  #capturePendingPublicationState(): PublicationIterationState {
    const pendingGenerations = this.#pendingPublicationGenerations.splice(0);
    this.#pendingPublicationGenerations = [];
    const generation = this.#publicationGeneration + 1;
    this.#publicationGeneration = generation;
    const pendingCommandResults = pendingGenerations.flatMap((entry) => entry.commandResults);
    const pendingCellEntries = this.#world.grid.dirtyCells.capturePending();
    return {
      generation,
      authorityWorld: this.#world,
      commandResults: pendingCommandResults,
      dirtyCells: pendingCellEntries.map((entry) => ({ ...entry })),
      pendingGenerations,
    };
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
    this.#lastCommandResults = [];
    this.#pendingPublicationGenerations = [];
    this.#nextActorSequenceByPlayer = new Map<PlayerId, number>();
    this.#nextActorSequenceByPlayer.set(this.#ownerPlayerId, (this.#world.commandLedger.actorHighWater[this.#ownerPlayerId] ?? 0) + 1);
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

  #queuePublicationRequest(options: PublicationOptions): void {
    const generation = this.#publicationGeneration + 1;
    const pendingRequest = this.#publicationRequests.at(-1);
    if (pendingRequest?.generation === generation) {
      pendingRequest.options = {
        force: Boolean(pendingRequest.options.force || options.force),
        materializeSnapshot: Boolean(pendingRequest.options.materializeSnapshot || options.materializeSnapshot),
        publishResults: Boolean(pendingRequest.options.publishResults || options.publishResults),
        throwOnError: pendingRequest.options.throwOnError !== false || options.throwOnError !== false,
      };
      return;
    }
    this.#publicationRequests.push({
      generation,
      options: { ...options },
    });
  }

  #publish(options: PublicationOptions = {}): void {
    this.#queuePublicationRequest(options);
    if (this.#publishInProgress) {
      return;
    }

    this.#publishInProgress = true;
    const errors: unknown[] = [];
    let shouldThrow = false;
    try {
      while (this.#publicationRequests.length > 0) {
        const request = this.#publicationRequests.shift();
        if (!request) {
          continue;
        }
        const requestOptions = request.options;
        const subscribers = this.#subscribers.slice();
        const publicationState = this.#capturePendingPublicationState();
        const shouldPublishIteration = Boolean(requestOptions.force || requestOptions.publishResults || publicationState.commandResults.length > 0 || publicationState.dirtyCells.length > 0);
        if (shouldPublishIteration) {
          const iterationErrors = this.#publishOnce(publicationState, requestOptions, subscribers);
          errors.push(...iterationErrors);
          if (iterationErrors.length > 0 && requestOptions.throwOnError !== false) {
            shouldThrow = true;
          }
        }
      }
    } finally {
      this.#publishInProgress = false;
    }

    if (errors.length > 0 && shouldThrow) {
      const message = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
      throw new AggregateError(errors, `LocalTransport subscriber publication failed: ${message}`);
    }
  }

  #publishOnce(publicationState: PublicationIterationState, options: PublicationOptions = {}, subscribers: TransportSubscriber[] = this.#subscribers.slice()): unknown[] {
    const authorityWorld = publicationState.authorityWorld;
    const pendingCommandResults = publicationState.commandResults;
    const pendingCellEntries = publicationState.dirtyCells;
    const nextDelta = this.#buildDelta(this.#replica.snapshot, authorityWorld, pendingCellEntries);
    const lastCommandResults = pendingCommandResults;
    const shouldPublish = Boolean(options.force || nextDelta !== null || lastCommandResults.length > 0);
    if (!shouldPublish) {
      this.#replica.lastCommandResults = lastCommandResults.slice();
      return [];
    }
    const authorityRevision = this.#getAuthorityRevision(authorityWorld);
    const publicationRevision = authorityRevision;
    const effectiveRevision = authorityRevision;
    const forceResync = Boolean(options.materializeSnapshot);

    this.#updateReplica(this.#replica, nextDelta, authorityWorld, authorityRevision, effectiveRevision, { forceResync });
    this.#replica.lastCommandResults = lastCommandResults;
    if (nextDelta !== null) {
      for (const cellDelta of nextDelta.cells) {
        this.#publishedCellRevisions.set(cellDelta.index, cellDelta.revision);
      }
    }
    this.#publicationCadence.markPublished(publicationRevision);

    const errors: unknown[] = [];
    for (const subscriber of subscribers) {
      if (!this.#subscribers.includes(subscriber)) {
        continue;
      }
      try {
        subscriber.initialSyncPending = false;
        if (nextDelta && subscriber.replica.snapshot.worldRevision !== nextDelta.baseRevision) {
          this.#resyncReplicaToAuthority(subscriber.replica, authorityWorld, authorityRevision, effectiveRevision);
        } else {
          this.#updateReplica(subscriber.replica, nextDelta, authorityWorld, authorityRevision, effectiveRevision, { forceResync });
        }
        subscriber.replica.lastCommandResults = lastCommandResults;
        this.#notifySubscriber(subscriber, this.#buildClientState(subscriber.replica, Boolean(options.materializeSnapshot)));
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      return errors;
    }

    authorityWorld.grid.dirtyCells.commitPending(pendingCellEntries);
    return errors;
  }

  #notifySubscriber(subscriber: TransportSubscriber, state: TransportClientState): void {
    this.#notificationDepth += 1;
    try {
      subscriber.listener(state);
    } finally {
      this.#notificationDepth -= 1;
    }
  }

  #buildDelta(previousSnapshot: WorldSnapshot, authorityWorld: WorldState, dirtyCellEntries: DirtyCellEntry[]): WorldDelta | null {
    const commandLedgerDelta = createCommandLedgerDelta(this.#replica.snapshot.worldState.commandLedger, authorityWorld.commandLedger);
    return createWorldDelta(previousSnapshot, authorityWorld, {
      dirtyCellEntries,
      publishedCellRevisions: this.#publishedCellRevisions,
      commandLedgerDelta,
    });
  }

  #updateReplica(replica: TransportReplica, delta: WorldDelta | null, authorityWorld: WorldState, authorityRevision: number, replicaRevision: number, options: { forceResync?: boolean; materializeSnapshot?: boolean } = {}): void {
    if (options.forceResync) {
      this.#syncReplicaFromAuthority(replica, authorityWorld, authorityRevision, replicaRevision);
      return;
    }
    replica.delta = delta ?? null;
    if (!delta) {
      replica.snapshot.checksum = "";
      replica.canonicalSnapshot = null;
      replica.revision = replicaRevision;
      return;
    }
    try {
      applyWorldDeltaToSnapshotStateFast(replica.snapshot.worldState, delta);
    } catch (error) {
      if (this.#isReplicaResyncError(error)) {
        this.#resyncReplicaToAuthority(replica, authorityWorld, authorityRevision, replicaRevision);
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

  #resyncReplicaToAuthority(replica: TransportReplica, authorityWorld: WorldState, authorityRevision: number, replicaRevision: number): void {
    this.#syncReplicaFromAuthority(replica, authorityWorld, authorityRevision, replicaRevision);
  }

  #syncReplicaFromAuthority(replica: TransportReplica, authorityWorld: WorldState, authorityRevision: number, replicaRevision: number): void {
    const snapshot = createWorldSnapshot(authorityWorld);
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
      case "commandLedger": {
        const ledgerValue = cloneDeltaValue(delta.value) as unknown;
        if (typeof ledgerValue === "object" && ledgerValue !== null && !Array.isArray(ledgerValue) && (ledgerValue as Record<string, unknown>)["kind"] === "incremental") {
          const incrementalLedger = ledgerValue as { actorHighWater: Record<string, number>; appendedReceipts: Array<unknown>; trimmedCount: number };
          const ledger = world.commandLedger;
          for (const [actorId, actorSequence] of Object.entries(incrementalLedger.actorHighWater)) {
            ledger.actorHighWater[actorId] = actorSequence;
          }
          if (incrementalLedger.trimmedCount > 0) {
            ledger.recent.splice(0, Math.min(incrementalLedger.trimmedCount, ledger.recent.length));
          }
          for (const receipt of incrementalLedger.appendedReceipts) {
            ledger.recent.push(receipt as typeof ledger.recent[number]);
          }
          if (ledger.recent.length > 256) {
            ledger.recent.splice(0, ledger.recent.length - 256);
          }
          return;
        }
        world.commandLedger = cloneDeltaValue(delta.value) as typeof world.commandLedger;
        return;
      }
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
  return cloneWorldStateFromReplication(world);
}

function cloneCommandResult(result: CommandResult): CommandResult {
  return {
    ...result,
    command: result.command ? { ...result.command } : result.command,
  };
}
