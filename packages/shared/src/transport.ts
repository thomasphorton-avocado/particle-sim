import { advanceWorldTick, type PlayerInputState } from "./gameplay.js";
import { createCommandEnvelope, getNextActorSequence, processPendingCommands, type CommandResult, type GameplayCommand } from "./commands.js";
import { type PlayerId } from "./ids.js";
import { type WorldState, createDefaultPlayerState, createDefaultWorldState } from "./world-state.js";
import { createPlayerId } from "./ids.js";
import { applyWorldDeltaToSnapshotState, cloneDeltaValue, cloneWorldDelta, cloneWorldSnapshot, createWorldDelta, createWorldSnapshot, restoreWorldState, type WorldDelta, type WorldSnapshot } from "./replication.js";
import type { DirtyCellEntry } from "./dirty-journal.js";

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

export class LocalTransport {
  #world: WorldState;
  #ownerPlayerId: PlayerId;
  #replica: TransportReplica;
  #subscribers: TransportSubscriber[];
  #lastCommandResults: CommandResult[];
  #publishedCellRevisions: Map<number, number>;
  #editorCapability: LocalTransportEditorCapability;
  #publishInProgress: boolean;
  #publishQueued: boolean;

  constructor(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1")) {
    this.#world = cloneWorldState(world);
    this.#ownerPlayerId = ownerPlayerId;
    this.#prepareWorld();
    this.#replica = this.#createReplica(createWorldSnapshot(this.#world));
    this.#subscribers = [];
    this.#lastCommandResults = [];
    this.#publishedCellRevisions = new Map<number, number>();
    this.#editorCapability = this.#createEditorCapability();
    this.#publishInProgress = false;
    this.#publishQueued = false;
  }

  subscribe(listener: TransportListener): () => void {
    this.#subscribers.push({
      listener,
      replica: this.#createReplica(this.#getSubscriptionSnapshot()),
    });
    return () => {
      this.#subscribers = this.#subscribers.filter((entry) => entry.listener !== listener);
    };
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
    const results = processPendingCommands(this.#world);
    this.#lastCommandResults = results;
    if (this.#world.paused) {
      clearPendingInputs(this.#world);
      this.#publish();
      return;
    }
    const resolvedInputs = buildResolvedInputs(this.#world, this.#ownerPlayerId, input);
    advanceWorldTick(this.#world, resolvedInputs);
    this.#publish();
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
    this.#world = cloneWorldState(world);
    this.#prepareWorld();
    this.#publishedCellRevisions.clear();
    this.#replica = this.#createReplica(createWorldSnapshot(this.#world));
    this.#subscribers = this.#subscribers.map((subscriber) => ({
      ...subscriber,
      replica: this.#createReplica(this.#replica.snapshot),
    }));
    this.#lastCommandResults = [];
    this.#publish();
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

  #publish(): void {
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
        const iterationErrors = this.#publishOnce();
        errors.push(...iterationErrors);
        if (this.#publishQueued) {
          this.#publishQueued = false;
          shouldRun = true;
        }
      }
    } finally {
      this.#publishInProgress = false;
    }

    if (errors.length > 0) {
      const message = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
      throw new AggregateError(errors, `LocalTransport subscriber publication failed: ${message}`);
    }
  }

  #publishOnce(): unknown[] {
    const pendingCellEntries = this.#world.grid.dirtyCells.readPending();
    const nextDelta = this.#buildDelta(this.#replica.snapshot, pendingCellEntries);
    const lastCommandResults = this.#lastCommandResults.map((result) => cloneCommandResult(result));
    const subscribers = this.#subscribers.slice();
    this.#commitPublication(nextDelta, lastCommandResults, pendingCellEntries);

    const errors: unknown[] = [];
    for (const subscriber of subscribers) {
      try {
        this.#updateReplica(subscriber.replica, nextDelta);
        subscriber.replica.lastCommandResults = lastCommandResults;
        subscriber.listener(this.#buildClientState(subscriber.replica));
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  #commitPublication(nextDelta: WorldDelta | null, lastCommandResults: CommandResult[], _pendingCellEntries: DirtyCellEntry[]): void {
    this.#updateReplica(this.#replica, nextDelta);
    this.#replica.lastCommandResults = lastCommandResults;
    this.#world.grid.dirtyCells.flush();
    if (nextDelta !== null) {
      for (const cellDelta of nextDelta.cells) {
        this.#publishedCellRevisions.set(cellDelta.index, cellDelta.revision);
      }
    }
    if (nextDelta !== null) {
      this.#world.worldRevision = nextDelta.targetRevision;
    }
  }

  #buildDelta(previousSnapshot: WorldSnapshot, dirtyCellEntries: DirtyCellEntry[]): WorldDelta | null {
    return createWorldDelta(previousSnapshot, this.#world, {
      dirtyCellEntries,
      publishedCellRevisions: this.#publishedCellRevisions,
    });
  }

  #updateReplica(replica: TransportReplica, delta: WorldDelta | null): void {
    replica.delta = delta ? cloneWorldDelta(delta) : null;
    const authorityRevision = this.#world.worldRevision;
    if (!delta) {
      replica.revision = authorityRevision;
      replica.snapshot.worldRevision = authorityRevision;
      replica.snapshot.worldState.worldRevision = authorityRevision;
      replica.snapshot.checksum = "";
      replica.canonicalSnapshot = null;
      return;
    }
    applyWorldDeltaToSnapshotState(replica.snapshot.worldState, delta);
    replica.snapshot.worldRevision = authorityRevision;
    replica.snapshot.worldState.worldRevision = authorityRevision;
    replica.snapshot.checksum = "";
    replica.revision = authorityRevision;
    replica.canonicalSnapshot = null;
    this.#applyDeltaToWorld(replica.clientWorld, delta, authorityRevision);
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
      this.#applyMetadataDelta(world, metadataDelta);
    }
    world.worldRevision = authorityRevision;
  }

  #applyMetadataDelta(world: WorldState, delta: WorldDelta["metadata"][number]): void {
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
        world.worldRevision = delta.value as typeof world.worldRevision;
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

  static createSession(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1")): LocalTransportSession {
    const transport = new LocalTransport(world, ownerPlayerId);
    return {
      transport,
      editor: transport.#editorCapability,
    };
  }
}

export function createLocalTransportSession(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1")): LocalTransportSession {
  return LocalTransport.createSession(world, ownerPlayerId);
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
