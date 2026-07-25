import { advanceWorldTick, createCommandEnvelope, enqueueCommand, getNextActorSequence, processPendingCommands, type GameplayCommand, type PlayerId, type PlayerInputState, type WorldState } from "@particle-sim/shared";
import { state } from "./state";

function enqueueEnvelope(world: WorldState, actorId: PlayerId, command: GameplayCommand, issuedTick: number): void {
  if (world === state.world) {
    state.transport.enqueueCommand(command);
    return;
  }
  const envelope = createCommandEnvelope(actorId, getNextActorSequence(world, actorId), issuedTick, command);
  enqueueCommand(world, envelope);
}

export function enqueueInputStateCommand(world: WorldState, actorId: PlayerId, input: PlayerInputState, issuedTick: number): void {
  enqueueEnvelope(world, actorId, {
    type: "set_input_state",
    left: input.left,
    right: input.right,
    jumpHeld: input.jumpHeld,
    crouchHeld: input.crouchHeld,
    lookUpHeld: input.lookUpHeld,
  }, issuedTick);
}

export function enqueueMineTransitionCommand(world: WorldState, actorId: PlayerId, mineHeld: boolean, issuedTick: number): void {
  enqueueEnvelope(world, actorId, {
    type: mineHeld ? "mine_start" : "mine_stop",
  }, issuedTick);
}

export function processProductionTick(world: WorldState, _transientInputs?: Readonly<Record<string, PlayerInputState>>): void {
  if (world === state.world) {
    const localInput = _transientInputs?.[state.localPlayerId];
    state.transport.advanceTick(localInput);
    return;
  }

  processPendingCommands(world);
  if (world.paused) return;
  const resolvedInputs = Object.fromEntries(
    Object.keys(world.players)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((playerId) => [playerId, world.players[playerId]?.input]),
  ) as Record<string, PlayerInputState>;
  advanceWorldTick(world, resolvedInputs);
}
