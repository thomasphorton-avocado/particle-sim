import test from "node:test";
import assert from "node:assert/strict";
import { LocalTransport, MaterialId, createCommandEnvelope, createDefaultPlayerState, createDefaultWorldState, createPlayerId } from "@particle-sim/shared";

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

test("LocalTransport initializes placed faucets at low-flow and cycles them through the replicated client state", () => {
  const { world, actorId } = createWorldWithPlayer();
  const transport = new LocalTransport(world);
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const placeEnvelope = createCommandEnvelope(actorId, 1, 0, {
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });

  transport.enqueueCommand(placeEnvelope);
  transport.advanceTick();

  const placeResults = transport.getLastCommandResults();
  assert.equal(placeResults.length, 1);
  assert.equal(placeResults[0].kind, "accepted");
  assert.equal(player.hotbar[0].kind, "empty");
  assert.equal(player.inventoryRevision, 1);

  const objectId = world.grid.getObjectId(10, 10);
  assert.ok(objectId);
  const objectCells = world.grid.getObjectCellIndices(objectId);
  assert.ok(objectCells.length > 0);
  for (const index of objectCells) {
    const x = index % world.grid.width;
    const y = Math.floor(index / world.grid.width);
    assert.equal(world.grid.get(x, y), MaterialId.Faucet);
    assert.equal(world.grid.getObjectId(x, y), objectId);
    assert.equal(world.grid.getFaucetFlow(x, y), 1);
  }

  const clientWorldAfterPlace = transport.getClientWorld();
  for (const index of objectCells) {
    const x = index % clientWorldAfterPlace.grid.width;
    const y = Math.floor(index / clientWorldAfterPlace.grid.width);
    assert.equal(clientWorldAfterPlace.grid.get(x, y), MaterialId.Faucet);
    assert.equal(clientWorldAfterPlace.grid.getObjectId(x, y), objectId);
    assert.equal(clientWorldAfterPlace.grid.getFaucetFlow(x, y), 1);
  }

  const cycleEnvelope = createCommandEnvelope(actorId, 2, 1, {
    type: "cycle_faucet",
    x: 10,
    y: 10,
    objectId,
    expectedTargetRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });

  transport.enqueueCommand(cycleEnvelope);
  transport.advanceTick();

  const cycleResults = transport.getLastCommandResults();
  assert.equal(cycleResults.length, 1);
  assert.equal(cycleResults[0].kind, "accepted");
  for (const index of objectCells) {
    const x = index % world.grid.width;
    const y = Math.floor(index / world.grid.width);
    assert.equal(world.grid.getFaucetFlow(x, y), 2);
  }
  const clientWorldAfterCycle = transport.getClientWorld();
  for (const index of objectCells) {
    const x = index % clientWorldAfterCycle.grid.width;
    const y = Math.floor(index / clientWorldAfterCycle.grid.width);
    assert.equal(clientWorldAfterCycle.grid.getFaucetFlow(x, y), 2);
  }
});

test("LocalTransport clears the hotbar slot after one-unit object placement and rejects the next placement without authority mutation", () => {
  const { world, actorId } = createWorldWithPlayer();
  const transport = new LocalTransport(world);
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const firstEnvelope = createCommandEnvelope(actorId, 1, 0, {
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });

  transport.enqueueCommand(firstEnvelope);
  transport.advanceTick();

  const firstResult = transport.getLastCommandResults()[0];
  assert.equal(firstResult.kind, "accepted");
  assert.equal(firstResult.code, "accepted");
  assert.equal(player.hotbar[0].kind, "empty");
  const authorityOrderAfterFirst = world.commandLedger.authorityOrder;
  const worldRevisionAfterFirst = world.worldRevision;
  const inventoryRevisionAfterFirst = player.inventoryRevision;
  const targetRevisionAfterFirst = world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0;

  const secondEnvelope = createCommandEnvelope(actorId, 2, 1, {
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: inventoryRevisionAfterFirst,
    expectedAnchorRevision: targetRevisionAfterFirst,
  });

  transport.enqueueCommand(secondEnvelope);
  transport.advanceTick();

  const secondResult = transport.getLastCommandResults()[0];
  assert.equal(secondResult.kind, "rejected");
  assert.equal(secondResult.code, "tool");
  assert.equal(player.hotbar[0].kind, "empty");
  assert.equal(world.commandLedger.authorityOrder, authorityOrderAfterFirst);
  assert.equal(world.worldRevision, worldRevisionAfterFirst);
  assert.equal(player.inventoryRevision, inventoryRevisionAfterFirst);
  assert.equal(world.grid.get(10, 10), MaterialId.Faucet);
});

test("LocalTransport clears the brush stack when it is fully consumed and preserves positive counts for partial consumption", () => {
  const { world, actorId } = createWorldWithPlayer();
  const transport = new LocalTransport(world);
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Sand, count: 2 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const fullStackEnvelope = createCommandEnvelope(actorId, 1, 0, {
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });

  transport.enqueueCommand(fullStackEnvelope);
  transport.advanceTick();

  const fullStackResult = transport.getLastCommandResults()[0];
  assert.equal(fullStackResult.kind, "accepted");
  assert.equal(player.hotbar[0].kind, "empty");

  const partialWorld = createDefaultWorldState("room_transport_partial");
  const partialActorId = createPlayerId("player_transport_partial");
  partialWorld.players[partialActorId] = createDefaultPlayerState(partialActorId);
  const partialTransport = new LocalTransport(partialWorld);
  const partialPlayer = partialWorld.players[partialActorId];
  partialPlayer.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Sand, count: 4 }
    : { kind: "empty" });
  partialPlayer.activeHotbarSlot = 0;

  partialWorld.grid.set(10, 10, MaterialId.Torch);
  partialWorld.grid.set(11, 10, MaterialId.Torch);

  const partialEnvelope = createCommandEnvelope(partialActorId, 1, 0, {
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: partialPlayer.inventoryRevision,
    expectedAnchorRevision: partialWorld.grid.cellRevisions[partialWorld.grid.index(10, 10)] ?? 0,
  });

  partialTransport.enqueueCommand(partialEnvelope);
  partialTransport.advanceTick();

  const partialResult = partialTransport.getLastCommandResults()[0];
  assert.equal(partialResult.kind, "accepted");
  assert.equal(partialPlayer.hotbar[0].kind, "material");
  assert.equal(partialPlayer.hotbar[0].count, 1);
});
