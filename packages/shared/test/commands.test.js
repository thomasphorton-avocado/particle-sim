import test from "node:test";
import assert from "node:assert/strict";
import { createCommandEnvelope, createDefaultPlayerState, createDefaultWorldState, createPlayerId, processCommand } from "@particle-sim/shared";

function createWorldWithPlayer() {
  const world = createDefaultWorldState("room_commands");
  const actorId = createPlayerId("player_1");
  world.players[actorId] = createDefaultPlayerState(actorId);
  return { world, actorId };
}

test("exact duplicate commands return the original result without advancing order", () => {
  const { world, actorId } = createWorldWithPlayer();
  const envelope = createCommandEnvelope(actorId, 1, 0, { type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });

  const first = processCommand(world, envelope);
  const duplicate = processCommand(world, envelope);

  assert.deepEqual(duplicate, first);
  assert.equal(world.commandLedger.recent.length, 1);
  assert.equal(world.nextAuthorityOrder, 2);
  assert.equal(world.commandLedger.actorHighWater[actorId], 1);
});

test("out-of-order actor sequence is rejected without consuming order", () => {
  const { world, actorId } = createWorldWithPlayer();
  const envelope = createCommandEnvelope(actorId, 2, 0, { type: "set_input_state", left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "rejected");
  assert.equal(result.code, "future_tick");
  assert.equal(world.nextAuthorityOrder, 1);
  assert.equal(world.commandLedger.recent.length, 1);
  assert.equal(world.commandLedger.actorHighWater[actorId], undefined);
});
