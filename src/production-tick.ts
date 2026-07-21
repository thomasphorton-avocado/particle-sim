import { advanceWorldTick, createCommandEnvelope, enqueueCommand, getNextActorSequence, processPendingCommands, type PlayerId, type PlayerInputState, type WorldState } from "@particle-sim/shared";

export function enqueueInputStateCommand(world: WorldState, actorId: PlayerId, input: PlayerInputState, issuedTick: number): void {
  const envelope = createCommandEnvelope(actorId, getNextActorSequence(world, actorId), issuedTick, {
    type: "set_input_state",
    left: input.left,
    right: input.right,
    jumpHeld: input.jumpHeld,
    crouchHeld: input.crouchHeld,
    lookUpHeld: input.lookUpHeld,
  });
  enqueueCommand(world, envelope);
}

export function enqueueMineTransitionCommand(world: WorldState, actorId: PlayerId, mineHeld: boolean, issuedTick: number): void {
  const envelope = createCommandEnvelope(actorId, getNextActorSequence(world, actorId), issuedTick, {
    type: mineHeld ? "mine_start" : "mine_stop",
  });
  enqueueCommand(world, envelope);
}

export function processProductionTick(world: WorldState, _transientInputs?: Readonly<Record<string, PlayerInputState>>): void {
  processPendingCommands(world);
  if (world.paused) return;
  const resolvedInputs = Object.fromEntries(
    Object.keys(world.players)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((playerId) => [playerId, world.players[playerId]?.input]),
  ) as Record<string, PlayerInputState>;
  advanceWorldTick(world, resolvedInputs);
}
