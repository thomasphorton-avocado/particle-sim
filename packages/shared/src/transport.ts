import { advanceWorldTick, type PlayerInputState } from "./gameplay.js";
import { createCommandEnvelope, getNextActorSequence, processPendingCommands, type CommandResult, type GameplayCommand } from "./commands.js";
import { type PlayerId } from "./ids.js";
import { type WorldState, createDefaultPlayerState, createDefaultWorldState } from "./world-state.js";
import { createPlayerId } from "./ids.js";
import { createWorldSnapshot, restoreWorldState, type WorldCellDelta, type WorldDelta, type WorldSnapshot } from "./replication.js";
import { MaterialId } from "./materials.js";
import { type FallingObjectStateDto, type PlayerStateDto, type GridDto } from "./serialization.js";

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
  getAuthoritativeWorld(): WorldState;
  replaceWorld(world: WorldState): void;
  mutateWorld(mutator: (world: WorldState) => void): void;
}

export interface LocalTransportSession {
  transport: LocalTransport;
  editor: LocalTransportEditorCapability;
}

export class LocalTransport {
  #world: WorldState;
  #ownerPlayerId: PlayerId;
  #snapshot: WorldSnapshot;
  #delta: WorldDelta | null;
  #revision: number;
  #lastCommandResults: CommandResult[];
  #listeners: TransportListener[];
  #editorCapability: LocalTransportEditorCapability;

  constructor(world: WorldState = createDefaultWorldState("room_default"), ownerPlayerId: PlayerId = createPlayerId("player_1")) {
    this.#world = cloneWorldState(world);
    this.#ownerPlayerId = ownerPlayerId;
    this.#prepareWorld();
    this.#snapshot = createWorldSnapshot(this.#world);
    this.#delta = null;
    this.#revision = this.#snapshot.worldRevision;
    this.#lastCommandResults = [];
    this.#listeners = [];
    this.#editorCapability = this.#createEditorCapability();
  }

  subscribe(listener: TransportListener): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((entry) => entry !== listener);
    };
  }

  getClientWorld(): WorldState {
    return restoreWorldState(this.#snapshot);
  }

  getClientSnapshot(): WorldSnapshot {
    return cloneWorldSnapshot(this.#snapshot);
  }

  getClientDelta(): WorldDelta | null {
    return this.#delta ? cloneWorldDelta(this.#delta) : null;
  }

  getClientState(): TransportClientState {
    const snapshot = cloneWorldSnapshot(this.#snapshot);
    return {
      revision: this.#revision,
      snapshot,
      delta: this.#delta ? cloneWorldDelta(this.#delta) : null,
      clientWorld: restoreWorldState(snapshot),
      lastCommandResults: this.#lastCommandResults.map((result) => cloneCommandResult(result)),
    };
  }

  getLastCommandResults(): ReadonlyArray<CommandResult> {
    return this.#lastCommandResults.map((result) => cloneCommandResult(result));
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
    this.#snapshot = createWorldSnapshot(this.#world);
    this.#delta = null;
    this.#revision = this.#snapshot.worldRevision;
    this.#lastCommandResults = [];
    this.#publish();
  }

  #getAuthoritativeWorldForEditor(): WorldState {
    return this.#world;
  }

  #createEditorCapability(): LocalTransportEditorCapability {
    return {
      getAuthoritativeWorld: () => this.#getAuthoritativeWorldForEditor(),
      replaceWorld: (world: WorldState) => this.#replaceWorldForEditor(world),
      mutateWorld: (mutator: (world: WorldState) => void) => {
        const world = this.#getAuthoritativeWorldForEditor();
        mutator(world);
        this.#replaceWorldForEditor(world);
      },
    };
  }

  #publish(): void {
    const nextSnapshot = createWorldSnapshot(this.#world);
    const nextDelta = this.#snapshot.worldRevision === nextSnapshot.worldRevision
      ? null
      : buildWorldDelta(this.#snapshot, nextSnapshot);
    this.#snapshot = nextSnapshot;
    this.#delta = nextDelta;
    this.#revision = this.#snapshot.worldRevision;
    for (const listener of this.#listeners) {
      listener(this.getClientState());
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

function cloneWorldSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  return {
    version: snapshot.version,
    worldRevision: snapshot.worldRevision,
    checksum: snapshot.checksum,
    worldState: JSON.parse(JSON.stringify(snapshot.worldState)),
  };
}

function cloneWorldDelta(delta: WorldDelta): WorldDelta {
  return JSON.parse(JSON.stringify(delta));
}

function cloneCommandResult(result: CommandResult): CommandResult {
  return JSON.parse(JSON.stringify(result));
}

function buildWorldDelta(previousSnapshot: WorldSnapshot, nextSnapshot: WorldSnapshot): WorldDelta | null {
  const previousState = previousSnapshot.worldState;
  const nextState = nextSnapshot.worldState;
  const cells: WorldCellDelta[] = [];
  const players = [] as Array<{ playerId: string; state: PlayerStateDto }>;
  const fallingObjects = [] as Array<{ objectId: string; state: FallingObjectStateDto }>;
  const metadata = [] as Array<{ field: "roomId" | "tick" | "paused" | "time" | "weather" | "random" | "ownerPlayerId" | "worldRevision" | "nextAuthorityOrder" | "nextPlayerOrdinal" | "nextObjectOrdinal" | "commandLedger"; value: unknown }>;

  const previousGrid = previousState.grid;
  const nextGrid = nextState.grid;
  const previousObjectIdsByCell = buildObjectIdLookup(previousGrid);
  const nextObjectIdsByCell = buildObjectIdLookup(nextGrid);
  const totalCells = previousGrid.width * previousGrid.height;
  for (let index = 0; index < totalCells; index += 1) {
    const previousCell = previousGrid.ids[index];
    const nextCell = nextGrid.ids[index];
    const previousRevision = previousGrid.cellRevisions[index] ?? 0;
    const nextRevision = nextGrid.cellRevisions[index] ?? 0;
    if (previousCell !== nextCell || previousGrid.shade[index] !== nextGrid.shade[index] || previousGrid.auxiliary[index] !== nextGrid.auxiliary[index] || previousObjectIdsByCell[index] !== nextObjectIdsByCell[index] || previousRevision !== nextRevision) {
      cells.push({
        index,
        materialId: nextCell as MaterialId,
        shade: nextGrid.shade[index],
        auxiliary: nextGrid.auxiliary[index],
        objectId: nextObjectIdsByCell[index] ?? null,
        revision: nextRevision,
      });
    }
  }

  const playerIds = new Set([...Object.keys(previousState.players), ...Object.keys(nextState.players)]);
  for (const playerId of playerIds) {
    const previousPlayer = previousState.players[playerId];
    const nextPlayer = nextState.players[playerId];
    if (previousPlayer === undefined || nextPlayer === undefined || stableStringify(previousPlayer) !== stableStringify(nextPlayer)) {
      if (nextPlayer) {
        players.push({ playerId, state: nextPlayer });
      }
    }
  }

  const objectIds = new Set([...Object.keys(previousState.fallingObjects), ...Object.keys(nextState.fallingObjects)]);
  for (const objectId of objectIds) {
    const previousObject = previousState.fallingObjects[objectId];
    const nextObject = nextState.fallingObjects[objectId];
    if (previousObject === undefined || nextObject === undefined || stableStringify(previousObject) !== stableStringify(nextObject)) {
      if (nextObject) {
        fallingObjects.push({ objectId, state: nextObject });
      }
    }
  }

  const metadataFields: Array<"roomId" | "tick" | "paused" | "time" | "weather" | "random" | "ownerPlayerId" | "worldRevision" | "nextAuthorityOrder" | "nextPlayerOrdinal" | "nextObjectOrdinal" | "commandLedger"> = ["roomId", "tick", "paused", "time", "weather", "random", "ownerPlayerId", "worldRevision", "nextAuthorityOrder", "nextPlayerOrdinal", "nextObjectOrdinal", "commandLedger"];
  for (const field of metadataFields) {
    const previousValue = previousState[field as keyof typeof previousState];
    const nextValue = nextState[field as keyof typeof nextState];
    if (stableStringify(previousValue) !== stableStringify(nextValue)) {
      metadata.push({ field, value: nextValue });
    }
  }

  if (cells.length === 0 && players.length === 0 && fallingObjects.length === 0 && metadata.length === 0) {
    return null;
  }

  return {
    version: 1,
    baseRevision: previousSnapshot.worldRevision,
    targetRevision: nextSnapshot.worldRevision,
    gridDimensions: {
      width: nextState.grid.width,
      height: nextState.grid.height,
    },
    cells,
    players,
    fallingObjects,
    metadata,
  };
}

function buildObjectIdLookup(grid: GridDto): Array<string | null> {
  const lookup = new Array<string | null>(grid.width * grid.height).fill(null);
  for (const membership of grid.objectMembership) {
    const index = membership.x + membership.y * grid.width;
    if (index >= 0 && index < lookup.length) {
      lookup[index] = membership.objectId;
    }
  }
  return lookup;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
