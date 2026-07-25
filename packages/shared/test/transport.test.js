import test from "node:test";
import assert from "node:assert/strict";
import { LocalTransport, createCommandEnvelope, createDefaultPlayerState, createDefaultWorldState, createPlayerId } from "@particle-sim/shared";

function createWorldWithPlayer() {
  const world = createDefaultWorldState("room_transport");
  const actorId = createPlayerId("player_transport");
  world.players[actorId] = createDefaultPlayerState(actorId);
  return { world, actorId };
}

test("LocalTransport publishes snapshots and isolated client state after accepted commands", () => {
  const { world, actorId } = createWorldWithPlayer();
  const transport = new LocalTransport(world);
  const seenRevisions = [];

  transport.subscribe((state) => {
    seenRevisions.push(state.revision);
  });

  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "set_input_state",
    left: true,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
  });

  transport.enqueueCommand(envelope);
  transport.advanceTick();

  const lastResults = transport.getLastCommandResults();
  const clientState = transport.getClientState();
  const clientWorld = transport.getClientWorld();

  assert.equal(lastResults.length, 1);
  assert.equal(lastResults[0].kind, "accepted");
  assert.equal(world.players[actorId].input.left, true);
  assert.equal(clientState.revision, world.worldRevision);
  assert.equal(clientState.snapshot.worldRevision, world.worldRevision);

  transport.setPaused(true);
  const afterPauseState = transport.getClientState();
  assert.ok(afterPauseState.delta);
  assert.notStrictEqual(clientWorld, world);
  assert.notStrictEqual(clientWorld.players[actorId], world.players[actorId]);

  clientWorld.players[actorId].input.left = false;
  assert.equal(world.players[actorId].input.left, true);
  assert.equal(seenRevisions.at(-1), afterPauseState.revision);
});

test("LocalTransport pauses deterministic ticking and keeps revisions stable until unpaused", () => {
  const { world, actorId } = createWorldWithPlayer();
  const transport = new LocalTransport(world);
  const beforeTick = world.tick;

  transport.setPaused(true);
  transport.advanceTick();

  assert.equal(world.tick, beforeTick);
  assert.equal(transport.getClientState().revision, world.worldRevision);

  transport.setPaused(false);
  transport.advanceTick();

  assert.equal(world.tick, beforeTick + 1);
  assert.equal(world.players[actorId].input.left, false);
  assert.equal(transport.getClientState().revision, world.worldRevision);
});
