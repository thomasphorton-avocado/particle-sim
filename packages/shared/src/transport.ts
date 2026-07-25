import { advanceWorldTick, type PlayerInputState } from "./gameplay.js";
import { createCommandEnvelope, getNextActorSequence, processPendingCommands, type CommandResult, type GameplayCommand } from "./commands.js";
import { type PlayerId } from "./ids.js";
import { type WorldState, createDefaultPlayerState, createDefaultWorldState } from "./world-state.js";
import { createPlayerId } from "./ids.js";
import { applyWorldDeltaToSnapshotState, cloneWorldDelta, cloneWorldSnapshot, createWorldDelta, createWorldSnapshot, restoreWorldState, type WorldDelta, type WorldSnapshot } from "./replication.js";

export type DayNightPreset = "morning" | "day" | "dusk" | "night";

export interface TransportClientState {
  revision: number;
  snapshot: WorldSnapshot;
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

  constructor(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1")) {
    this.#world = cloneWorldState(world);
    this.#ownerPlayerId = ownerPlayerId;
    this.#prepareWorld();
    this.#replica = this.#createReplica(createWorldSnapshot(this.#world));
    this.#subscribers = [];
    this.#lastCommandResults = [];
    this.#publishedCellRevisions = new Map<number, number>();
    this.#editorCapability = this.#createEditorCapability();
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
        : cloneWorldSnapshot(replica.snapshot));
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
    const nextDelta = this.#buildDelta(this.#replica.snapshot);
    const lastCommandResults = this.#lastCommandResults.map((result) => cloneCommandResult(result));
    for (const subscriber of this.#subscribers) {
      this.#updateReplica(subscriber.replica, nextDelta);
      subscriber.replica.lastCommandResults = lastCommandResults;
      subscriber.listener(this.#buildClientState(subscriber.replica));
    }
    this.#updateReplica(this.#replica, nextDelta);
    this.#replica.lastCommandResults = lastCommandResults;
    if (nextDelta !== null || this.#world.grid.dirtyCells.size > 0) {
      this.#world.grid.dirtyCells.flush();
    }
  }

  #buildDelta(previousSnapshot: WorldSnapshot): WorldDelta | null {
    return createWorldDelta(previousSnapshot, this.#world, {
      dirtyCellEntries: this.#world.grid.dirtyCells.readPending(),
      publishedCellRevisions: this.#publishedCellRevisions,
    });
  }

  #updateReplica(replica: TransportReplica, delta: WorldDelta | null): void {
    replica.delta = delta ? cloneWorldDelta(delta) : null;
    if (!delta) {
      replica.revision = this.#world.worldRevision;
      replica.canonicalSnapshot = null;
      return;
    }
    applyWorldDeltaToSnapshotState(replica.snapshot.worldState, delta);
    replica.snapshot.worldRevision = delta.targetRevision;
    replica.snapshot.worldState.worldRevision = delta.targetRevision;
    replica.snapshot.checksum = "";
    replica.revision = delta.targetRevision;
    replica.canonicalSnapshot = null;
    this.#applyDeltaToWorld(replica.clientWorld, delta);
    for (const cellDelta of delta.cells) {
      this.#publishedCellRevisions.set(cellDelta.index, cellDelta.revision);
    }
  }

  #applyDeltaToWorld(world: WorldState, delta: WorldDelta): void {
    for (const cellDelta of delta.cells) {
      world.grid.applyCellState(cellDelta.index, cellDelta.materialId, cellDelta.shade, cellDelta.auxiliary, cellDelta.objectId as Parameters<typeof world.grid.applyCellState>[4], cellDelta.revision);
    }
    for (const playerDelta of delta.players) {
      if (playerDelta.state === null) {
        delete world.players[playerDelta.playerId];
        continue;
      }
      world.players[playerDelta.playerId] = playerDelta.state as typeof world.players[string];
    }
    for (const fallingObjectDelta of delta.fallingObjects) {
      if (fallingObjectDelta.state === null) {
        delete world.fallingObjects[fallingObjectDelta.objectId];
        continue;
      }
      world.fallingObjects[fallingObjectDelta.objectId] = fallingObjectDelta.state as typeof world.fallingObjects[string];
    }
    for (const metadataDelta of delta.metadata) {
      this.#applyMetadataDelta(world, metadataDelta);
    }
    world.worldRevision = delta.targetRevision;
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
        world.time = delta.value as typeof world.time;
        return;
      case "weather":
        world.weather = delta.value as typeof world.weather;
        return;
      case "random":
        world.random = delta.value as typeof world.random;
        return;
      case "ownerPlayerId":
        world.ownerPlayerId = delta.value as typeof world.ownerPlayerId;
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
        world.commandLedger = delta.value as typeof world.commandLedger;
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
