import { createCommandId, parseCommandId, type CommandId, type ObjectId, type PlayerId } from "./ids.js";
import { removeFromHotbarSlot } from "./inventory.js";
import { Grid, placeWorldCell } from "./grid.js";
import { MaterialId } from "./materials.js";
import { harvestFlowerCluster } from "./harvest.js";
import type { WorldState } from "./world-state.js";
import { serializeWorldState, deserializeWorldState } from "./serialization.js";

export type GameplayCommandType =
  | "set_input_state"
  | "mine_start"
  | "mine_stop"
  | "select_slot"
  | "place"
  | "harvest"
  | "cycle_faucet"
  | "pause_world"
  | "resume_world";

export interface SetInputStateCommand {
  type: "set_input_state";
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  crouchHeld: boolean;
  lookUpHeld: boolean;
}

export interface MineCommand {
  type: "mine_start" | "mine_stop";
}

export interface SelectSlotCommand {
  type: "select_slot";
  slot: number;
  expectedInventoryRevision: number;
}

export interface PlaceCommand {
  type: "place";
  x: number;
  y: number;
  brushRadius: number;
  expectedInventoryRevision: number;
  expectedAnchorRevision: number;
}

export interface HarvestCommand {
  type: "harvest";
  x: number;
  y: number;
  expectedTargetRevision: number;
}

export interface CycleFaucetCommand {
  type: "cycle_faucet";
  x: number;
  y: number;
  objectId: ObjectId;
  expectedTargetRevision: number;
}

export interface PauseWorldCommand {
  type: "pause_world";
  expectedWorldRevision: number;
}

export interface ResumeWorldCommand {
  type: "resume_world";
  expectedWorldRevision: number;
}

export type GameplayCommand =
  | SetInputStateCommand
  | MineCommand
  | SelectSlotCommand
  | PlaceCommand
  | HarvestCommand
  | CycleFaucetCommand
  | PauseWorldCommand
  | ResumeWorldCommand;

export interface CommandEnvelope {
  commandId: CommandId;
  actorId: PlayerId;
  actorSequence: number;
  issuedTick: number;
  command: GameplayCommand;
}

export type CommandResultCode =
  | "accepted"
  | "unknown_actor"
  | "paused"
  | "not_owner"
  | "already_state"
  | "future_tick"
  | "stale"
  | "conflict"
  | "slot"
  | "tool"
  | "revision"
  | "inventory"
  | "target"
  | "bounds"
  | "range"
  | "collision"
  | "footprint"
  | "work_limit"
  | "invalid_command";

export interface CommandReceipt {
  commandId: CommandId;
  actorId: PlayerId;
  actorSequence: number;
  authorityOrder: number | null;
  issuedTick: number;
  processedTick: number;
  commandType: GameplayCommandType;
  code: CommandResultCode;
  accepted: boolean;
  worldRevision: number;
  inventoryRevision: number;
  targetRevision: number;
  fingerprint: string;
}

export interface CommandResult {
  kind: "accepted" | "rejected";
  code: CommandResultCode;
  command: GameplayCommand;
  actor: PlayerId;
  actorSequence: number;
  type: GameplayCommandType;
  authorityOrder: number | null;
  issuedTick: number;
  processedTick: number;
  beforeWorldRevision: number;
  afterWorldRevision: number;
  beforeInventoryRevision: number;
  afterInventoryRevision: number;
  beforeTargetRevision: number;
  afterTargetRevision: number;
  acceptedEffect: string | null;
}

export interface ValidatedCommandPlan {
  kind: "plan";
  envelope: CommandEnvelope;
  resultCode: CommandResultCode;
  worldSnapshot: WorldState;
  accepted: boolean;
  authorityOrder: number | null;
  beforeWorldRevision: number;
  afterWorldRevision: number;
  beforeInventoryRevision: number;
  afterInventoryRevision: number;
  beforeTargetRevision: number;
  afterTargetRevision: number;
  acceptedEffect: string | null;
}

export interface CommandRejection {
  kind: "rejection";
  envelope: CommandEnvelope;
  code: CommandResultCode;
  admitted: boolean;
  authorityOrder: null;
}

function sanitizeCommandFingerprint(command: GameplayCommand): string {
  return JSON.stringify(command);
}

function createRejection(envelope: CommandEnvelope, code: CommandResultCode, admitted = false): CommandRejection {
  return { kind: "rejection", envelope, code, admitted, authorityOrder: null };
}

function createCommandResult(planOrRejection: ValidatedCommandPlan | CommandRejection, world: WorldState): CommandResult {
  if (planOrRejection.kind === "plan") {
    return {
      kind: "accepted",
      code: planOrRejection.resultCode,
      command: planOrRejection.envelope.command,
      actor: planOrRejection.envelope.actorId,
      actorSequence: planOrRejection.envelope.actorSequence,
      type: planOrRejection.envelope.command.type,
      authorityOrder: planOrRejection.authorityOrder,
      issuedTick: planOrRejection.envelope.issuedTick,
      processedTick: world.tick,
      beforeWorldRevision: planOrRejection.beforeWorldRevision,
      afterWorldRevision: planOrRejection.afterWorldRevision,
      beforeInventoryRevision: planOrRejection.beforeInventoryRevision,
      afterInventoryRevision: planOrRejection.afterInventoryRevision,
      beforeTargetRevision: planOrRejection.beforeTargetRevision,
      afterTargetRevision: planOrRejection.afterTargetRevision,
      acceptedEffect: planOrRejection.acceptedEffect,
    };
  }
  return {
    kind: "rejected",
    code: planOrRejection.code,
    command: planOrRejection.envelope.command,
    actor: planOrRejection.envelope.actorId,
    actorSequence: planOrRejection.envelope.actorSequence,
    type: planOrRejection.envelope.command.type,
    authorityOrder: null,
    issuedTick: planOrRejection.envelope.issuedTick,
    processedTick: world.tick,
    beforeWorldRevision: world.worldRevision,
    afterWorldRevision: world.worldRevision,
    beforeInventoryRevision: world.players[planOrRejection.envelope.actorId]?.inventoryRevision ?? 0,
    afterInventoryRevision: world.players[planOrRejection.envelope.actorId]?.inventoryRevision ?? 0,
    beforeTargetRevision: world.worldRevision,
    afterTargetRevision: world.worldRevision,
    acceptedEffect: null,
  };
}

function recordReceipt(world: WorldState, envelope: CommandEnvelope, result: CommandResult, authorityOrder: number | null): void {
  const ledger = world.commandLedger;
  if (result.kind === "accepted" || result.code !== "stale" && result.code !== "conflict") {
    ledger.actorHighWater[envelope.actorId] = envelope.actorSequence;
  }
  if (authorityOrder !== null) {
    world.nextAuthorityOrder = Math.max(world.nextAuthorityOrder, authorityOrder + 1);
  }
  const receipt: CommandReceipt = {
    commandId: envelope.commandId,
    actorId: envelope.actorId,
    actorSequence: envelope.actorSequence,
    authorityOrder,
    issuedTick: envelope.issuedTick,
    processedTick: world.tick,
    commandType: envelope.command.type,
    code: result.code,
    accepted: result.kind === "accepted",
    worldRevision: result.afterWorldRevision,
    inventoryRevision: result.afterInventoryRevision,
    targetRevision: result.afterTargetRevision,
    fingerprint: sanitizeCommandFingerprint(envelope.command),
  };
  ledger.recent.push(receipt);
  if (ledger.recent.length > 256) {
    ledger.recent.splice(0, ledger.recent.length - 256);
  }
}

function validateStrictInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${label} is out of range`);
  }
  return value;
}

function cloneWorldForPlanning(world: WorldState): WorldState {
  return deserializeWorldState(serializeWorldState(world));
}

function canPlaceOver(grid: Grid, x: number, y: number, materialId: MaterialId): boolean {
  const existing = grid.get(x, y);
  if (existing === MaterialId.Empty) return true;
  if (materialId === MaterialId.Empty) return true;
  if (existing === MaterialId.Water && !MaterialId.Water && !Object.prototype.hasOwnProperty.call({ [MaterialId.Water]: true }, materialId)) {
    return true;
  }
  return false;
}

function applyBrushPlacement(world: WorldState, x: number, y: number, materialId: MaterialId, radius: number): boolean {
  let placed = false;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const px = x + dx;
      const py = y + dy;
      if (!world.grid.inBounds(px, py)) continue;
      if (!canPlaceOver(world.grid, px, py, materialId)) continue;
      placeWorldCell(world, px, py, materialId);
      placed = true;
    }
  }
  return placed;
}

export function validateCommand(world: WorldState, envelope: CommandEnvelope): ValidatedCommandPlan | CommandRejection {
  const ledger = world.commandLedger;
  const actorHighWater = ledger.actorHighWater[envelope.actorId] ?? 0;
  const fingerprint = sanitizeCommandFingerprint(envelope.command);
  const recentReceipt = ledger.recent.find((receipt) => receipt.actorId === envelope.actorId && receipt.actorSequence === envelope.actorSequence && receipt.fingerprint === fingerprint);
  if (recentReceipt) {
    return createRejection(envelope, "accepted");
  }
  if (envelope.actorSequence <= actorHighWater) {
    return createRejection(envelope, "stale", false);
  }
  if (envelope.actorSequence > actorHighWater + 1) {
    return createRejection(envelope, "future_tick", false);
  }
  if (envelope.issuedTick > world.tick + 1) {
    return createRejection(envelope, "future_tick", true);
  }

  const draft = cloneWorldForPlanning(world);
  const actor = draft.players[envelope.actorId];
  if (!actor) {
    return createRejection(envelope, "unknown_actor", false);
  }

  if (draft.paused && envelope.command.type !== "pause_world" && envelope.command.type !== "resume_world") {
    return createRejection(envelope, "paused", true);
  }

  const beforeWorldRevision = draft.worldRevision;
  const beforeInventoryRevision = actor.inventoryRevision;
  const beforeTargetRevision = draft.worldRevision;
  let acceptedEffect: string | null = null;

  switch (envelope.command.type) {
    case "set_input_state": {
      actor.input = {
        left: Boolean(envelope.command.left),
        right: Boolean(envelope.command.right),
        jumpHeld: Boolean(envelope.command.jumpHeld),
        crouchHeld: Boolean(envelope.command.crouchHeld),
        lookUpHeld: Boolean(envelope.command.lookUpHeld),
        mineHeld: false,
      };
      acceptedEffect = "input";
      break;
    }
    case "mine_start": {
      actor.input.mineHeld = true;
      acceptedEffect = "mining";
      break;
    }
    case "mine_stop": {
      actor.input.mineHeld = false;
      acceptedEffect = "mining";
      break;
    }
    case "select_slot": {
      const slot = validateStrictInteger(envelope.command.slot, "slot", 0, 9);
      if (slot >= actor.hotbar.length) {
        return createRejection(envelope, "slot", true);
      }
      actor.activeHotbarSlot = slot;
      acceptedEffect = "hotbar";
      break;
    }
    case "place": {
      const slot = actor.activeHotbarSlot;
      const hotbarEntry = actor.hotbar[slot];
      if (hotbarEntry?.kind !== "material") {
        return createRejection(envelope, "tool", true);
      }
      const radius = validateStrictInteger(envelope.command.brushRadius, "brushRadius", 1, 16);
      if (envelope.command.expectedInventoryRevision !== actor.inventoryRevision) {
        return createRejection(envelope, "revision", true);
      }
      const applied = applyBrushPlacement(draft, envelope.command.x, envelope.command.y, hotbarEntry.materialId, radius);
      if (!applied) {
        return createRejection(envelope, "bounds", true);
      }
      if (!removeFromHotbarSlot(actor.hotbar, slot)) {
        return createRejection(envelope, "inventory", true);
      }
      actor.inventoryRevision += 1;
      draft.worldRevision += 1;
      acceptedEffect = "inventory";
      break;
    }
    case "harvest": {
      if (envelope.command.expectedTargetRevision !== beforeTargetRevision) {
        return createRejection(envelope, "revision", true);
      }
      const harvested = harvestFlowerCluster(draft.grid, envelope.command.x, envelope.command.y);
      if (harvested <= 0) {
        return createRejection(envelope, "target", true);
      }
      actor.inventory.flowers += harvested;
      actor.inventoryRevision += 1;
      draft.worldRevision += 1;
      acceptedEffect = "inventory";
      break;
    }
    case "cycle_faucet": {
      const cell = draft.grid.get(envelope.command.x, envelope.command.y);
      if (cell !== MaterialId.Faucet) {
        return createRejection(envelope, "target", true);
      }
      const current = draft.grid.getFaucetFlow(envelope.command.x, envelope.command.y);
      draft.grid.setFaucetFlow(envelope.command.x, envelope.command.y, (current + 1) % 3);
      draft.worldRevision += 1;
      acceptedEffect = "target";
      break;
    }
    case "pause_world": {
      if (draft.ownerPlayerId !== null && draft.ownerPlayerId !== envelope.actorId) {
        return createRejection(envelope, "not_owner", true);
      }
      if (draft.paused) {
        return createRejection(envelope, "already_state", true);
      }
      if (envelope.command.expectedWorldRevision !== draft.worldRevision) {
        return createRejection(envelope, "revision", true);
      }
      draft.paused = true;
      draft.worldRevision += 1;
      acceptedEffect = "pause";
      break;
    }
    case "resume_world": {
      if (draft.ownerPlayerId !== null && draft.ownerPlayerId !== envelope.actorId) {
        return createRejection(envelope, "not_owner", true);
      }
      if (!draft.paused) {
        return createRejection(envelope, "already_state", true);
      }
      if (envelope.command.expectedWorldRevision !== draft.worldRevision) {
        return createRejection(envelope, "revision", true);
      }
      draft.paused = false;
      draft.worldRevision += 1;
      acceptedEffect = "resume";
      break;
    }
    default: {
      return createRejection(envelope, "invalid_command", true);
    }
  }

  return {
    kind: "plan",
    envelope,
    resultCode: "accepted",
    worldSnapshot: draft,
    accepted: true,
    authorityOrder: null,
    beforeWorldRevision,
    afterWorldRevision: draft.worldRevision,
    beforeInventoryRevision,
    afterInventoryRevision: actor.inventoryRevision,
    beforeTargetRevision,
    afterTargetRevision: draft.worldRevision,
    acceptedEffect,
  };
}

export function commitValidatedPlan(world: WorldState, plan: ValidatedCommandPlan): void {
  world.roomId = plan.worldSnapshot.roomId;
  world.grid = plan.worldSnapshot.grid;
  world.random = plan.worldSnapshot.random;
  world.players = plan.worldSnapshot.players;
  world.fallingObjects = plan.worldSnapshot.fallingObjects;
  world.paused = plan.worldSnapshot.paused;
  world.tick = plan.worldSnapshot.tick;
  world.time = plan.worldSnapshot.time;
  world.weather = plan.worldSnapshot.weather;
  world.nextPlayerOrdinal = plan.worldSnapshot.nextPlayerOrdinal;
  world.nextObjectOrdinal = plan.worldSnapshot.nextObjectOrdinal;
  world.ownerPlayerId = plan.worldSnapshot.ownerPlayerId;
  world.worldRevision = plan.worldSnapshot.worldRevision;
  world.nextAuthorityOrder = plan.worldSnapshot.nextAuthorityOrder;
  world.commandLedger = plan.worldSnapshot.commandLedger;
  world.commandInbox = plan.worldSnapshot.commandInbox;
}

export function processCommand(world: WorldState, envelope: CommandEnvelope): CommandResult {
  const validation = validateCommand(world, envelope);
  if (validation.kind === "rejection") {
    const result = createCommandResult(validation, world);
    const authorityOrder = validation.admitted ? world.nextAuthorityOrder : null;
    if (validation.admitted) {
      world.nextAuthorityOrder += 1;
      world.commandLedger.actorHighWater[envelope.actorId] = envelope.actorSequence;
    }
    recordReceipt(world, envelope, result, authorityOrder);
    return result;
  }
  const result = createCommandResult(validation, world);
  const authorityOrder = world.nextAuthorityOrder + 1;
  world.nextAuthorityOrder = authorityOrder;
  world.commandLedger.actorHighWater[envelope.actorId] = envelope.actorSequence;
  commitValidatedPlan(world, validation);
  recordReceipt(world, envelope, result, authorityOrder);
  return result;
}

export function processPendingCommands(world: WorldState, inbox: CommandEnvelope[] = world.commandInbox ?? []): CommandResult[] {
  const results: CommandResult[] = [];
  for (const envelope of inbox) {
    results.push(processCommand(world, envelope));
  }
  if (world.commandInbox === inbox) {
    world.commandInbox = [];
  }
  return results;
}

export function createCommandEnvelope(actorId: PlayerId, actorSequence: number, issuedTick: number, command: GameplayCommand): CommandEnvelope {
  return {
    commandId: parseCommandId(`command_${actorId}_${actorSequence}`),
    actorId,
    actorSequence,
    issuedTick,
    command,
  };
}

export function createCommandIdValue(actorId: PlayerId, actorSequence: number): CommandId {
  return createCommandId(`command_${actorId}_${actorSequence}`);
}

export function enqueueCommand(world: WorldState, envelope: CommandEnvelope): void {
  world.commandInbox = [...(world.commandInbox ?? []), envelope];
}
