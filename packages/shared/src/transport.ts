import { advanceWorldTick, type PlayerInputState } from "./gameplay.js";
import { processPendingCommands, type CommandEnvelope, type CommandResult } from "./commands.js";
import { type WorldState, createDefaultWorldState } from "./world-state.js";
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

export class LocalTransport {
  public world: WorldState;

  private snapshot: WorldSnapshot;
  private delta: WorldDelta | null;
  private clientWorld: WorldState;
  private revision: number;
  private lastCommandResults: CommandResult[];
  private listeners: TransportListener[];

  constructor(world: WorldState = createDefaultWorldState("room_default")) {
    this.world = world;
    this.snapshot = createWorldSnapshot(world);
    this.clientWorld = restoreWorldState(this.snapshot);
    this.delta = null;
    this.revision = this.snapshot.worldRevision;
    this.lastCommandResults = [];
    this.listeners = [];
  }

  resetWorld(world: WorldState): void {
    this.world = world;
    this.snapshot = createWorldSnapshot(world);
    this.clientWorld = restoreWorldState(this.snapshot);
    this.delta = null;
    this.revision = this.snapshot.worldRevision;
    this.lastCommandResults = [];
    this.publish();
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  getAuthoritativeWorld(): WorldState {
    return this.world;
  }

  getClientWorld(): WorldState {
    return this.clientWorld;
  }

  getClientSnapshot(): WorldSnapshot {
    return this.snapshot;
  }

  getClientDelta(): WorldDelta | null {
    return this.delta;
  }

  getClientState(): TransportClientState {
    return {
      revision: this.revision,
      snapshot: this.snapshot,
      delta: this.delta,
      clientWorld: this.clientWorld,
      lastCommandResults: [...this.lastCommandResults],
    };
  }

  getLastCommandResults(): ReadonlyArray<CommandResult> {
    return [...this.lastCommandResults];
  }

  enqueueCommand(envelope: CommandEnvelope): void {
    this.world.commandInbox.push(envelope);
  }

  advanceTick(inputs?: Readonly<Record<string, PlayerInputState>>): void {
    const results = processPendingCommands(this.world);
    this.lastCommandResults = results;
    if (this.world.paused) {
      this.publish();
      return;
    }
    const resolvedInputs = buildResolvedInputs(this.world, inputs);
    advanceWorldTick(this.world, resolvedInputs);
    this.publish();
  }

  setTimePreset(preset: DayNightPreset): void {
    const presets: Record<DayNightPreset, number> = {
      morning: 0.0,
      day: 0.25,
      dusk: 0.5,
      night: 0.75,
    };
    this.world.time.dayNightCycle = presets[preset];
    this.world.time.dayNightTick = Math.round(presets[preset] * 18_000) % 18_000;
    this.bumpWorldRevision();
    this.publish();
  }

  setPaused(paused: boolean): void {
    this.world.paused = paused;
    this.bumpWorldRevision();
    this.publish();
  }

  private bumpWorldRevision(): void {
    this.world.worldRevision += 1;
  }

  private publish(): void {
    const nextSnapshot = createWorldSnapshot(this.world);
    const nextDelta = this.snapshot.worldRevision === nextSnapshot.worldRevision
      ? null
      : buildWorldDelta(this.snapshot, nextSnapshot);
    this.snapshot = nextSnapshot;
    this.delta = nextDelta;
    this.clientWorld = restoreWorldState(this.snapshot);
    this.revision = this.snapshot.worldRevision;
    const view = this.getClientState();
    for (const listener of this.listeners) {
      listener(view);
    }
  }
}

function buildResolvedInputs(world: WorldState, inputs?: Readonly<Record<string, PlayerInputState>>): Record<string, PlayerInputState> {
  if (inputs) {
    return Object.fromEntries(
      Object.keys(inputs)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((playerId) => [playerId, normalizeInputState(inputs[playerId])]),
    ) as Record<string, PlayerInputState>;
  }
  return Object.fromEntries(
    Object.keys(world.players)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((playerId) => [playerId, normalizeInputState(world.players[playerId]?.input)]),
  ) as Record<string, PlayerInputState>;
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
