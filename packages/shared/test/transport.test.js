import test from "node:test";
import assert from "node:assert/strict";
import { MaterialId, createDefaultPlayerState, createDefaultWorldState, createLocalTransportSession, createPlayerId } from "@particle-sim/shared";

function createWorldWithPlayer() {
  const world = createDefaultWorldState("room_transport");
  const actorId = createPlayerId("player_transport");
  world.players[actorId] = createDefaultPlayerState(actorId);
  return { world, actorId };
}

test("LocalTransport publishes snapshots and isolated client state after accepted commands", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const seenRevisions = [];

  transport.subscribe((state) => {
    seenRevisions.push(state.revision);
  });

  transport.enqueueCommand({
    type: "set_input_state",
    left: true,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
  });
  transport.advanceTick();

  const lastResults = transport.getLastCommandResults();
  const clientState = transport.getClientState();
  const clientWorld = transport.getClientWorld();

  assert.equal(lastResults.length, 1);
  assert.equal(lastResults[0].kind, "accepted");
  assert.equal(clientState.revision, transport.getClientWorld().worldRevision);
  assert.equal(clientState.snapshot.worldRevision, transport.getClientWorld().worldRevision);
  assert.equal(clientWorld.players[actorId].input.left, true);
  assert.equal(world.players[actorId].input.left, false);

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();
  const afterPauseState = transport.getClientState();
  assert.ok(afterPauseState.delta);
  assert.notStrictEqual(clientWorld, world);
  assert.notStrictEqual(clientWorld.players[actorId], world.players[actorId]);

  clientWorld.players[actorId].input.left = false;
  assert.equal(world.players[actorId].input.left, false);
  assert.equal(seenRevisions.at(-1), afterPauseState.revision);
});

test("LocalTransport pauses deterministic ticking and keeps revisions stable until unpaused", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const beforeTick = transport.getClientWorld().tick;

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();

  assert.equal(world.tick, 0);
  assert.equal(transport.getClientWorld().tick, beforeTick);
  assert.equal(transport.getClientState().revision, transport.getClientWorld().worldRevision);

  transport.enqueueCommand({ type: "resume_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();

  assert.equal(world.tick, 0);
  assert.equal(transport.getClientWorld().tick, beforeTick + 1);
  assert.equal(transport.getClientWorld().players[actorId].input.left, false);
  assert.equal(transport.getClientState().revision, transport.getClientWorld().worldRevision);
});

test("LocalTransport initializes placed faucets at low-flow and cycles them through the replicated client state", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const placeResults = transport.getLastCommandResults();
  assert.equal(placeResults.length, 1);
  assert.equal(placeResults[0].kind, "accepted");
  assert.equal(world.players[actorId].hotbar[0].kind, "material");
  assert.equal(world.players[actorId].inventoryRevision, 0);

  const clientWorldAfterPlace = transport.getClientWorld();
  const objectId = clientWorldAfterPlace.grid.getObjectId(10, 10);
  assert.ok(objectId);
  const objectCells = clientWorldAfterPlace.grid.getObjectCellIndices(objectId);
  assert.ok(objectCells.length > 0);
  for (const index of objectCells) {
    const x = index % clientWorldAfterPlace.grid.width;
    const y = Math.floor(index / clientWorldAfterPlace.grid.width);
    assert.equal(clientWorldAfterPlace.grid.get(x, y), MaterialId.Faucet);
    assert.equal(clientWorldAfterPlace.grid.getObjectId(x, y), objectId);
    assert.equal(clientWorldAfterPlace.grid.getFaucetFlow(x, y), 1);
  }
  const clientPlayerAfterPlace = clientWorldAfterPlace.players[actorId];
  assert.equal(clientPlayerAfterPlace.hotbar[0].kind, "empty");
  assert.equal(clientPlayerAfterPlace.inventoryRevision, 1);

  transport.enqueueCommand({
    type: "cycle_faucet",
    x: 10,
    y: 10,
    objectId,
    expectedTargetRevision: clientWorldAfterPlace.grid.cellRevisions[clientWorldAfterPlace.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const cycleResults = transport.getLastCommandResults();
  assert.equal(cycleResults.length, 1);
  assert.equal(cycleResults[0].kind, "accepted");
  const clientWorldAfterCycle = transport.getClientWorld();
  for (const index of objectCells) {
    const x = index % clientWorldAfterCycle.grid.width;
    const y = Math.floor(index / clientWorldAfterCycle.grid.width);
    assert.equal(clientWorldAfterCycle.grid.getFaucetFlow(x, y), 2);
  }
});

test("LocalTransport clears the hotbar slot after one-unit object placement and rejects the next placement without authority mutation", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const firstResult = transport.getLastCommandResults()[0];
  assert.equal(firstResult.kind, "accepted");
  assert.equal(firstResult.code, "accepted");
  assert.equal(world.players[actorId].hotbar[0].kind, "material");
  const clientWorldAfterFirst = transport.getClientWorld();
  assert.equal(clientWorldAfterFirst.players[actorId].hotbar[0].kind, "empty");
  const authorityOrderAfterFirst = clientWorldAfterFirst.worldRevision;
  const worldRevisionAfterFirst = clientWorldAfterFirst.worldRevision;
  const inventoryRevisionAfterFirst = clientWorldAfterFirst.players[actorId].inventoryRevision;
  const targetRevisionAfterFirst = clientWorldAfterFirst.grid.cellRevisions[clientWorldAfterFirst.grid.index(10, 10)] ?? 0;

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: inventoryRevisionAfterFirst,
    expectedAnchorRevision: targetRevisionAfterFirst,
  });
  transport.advanceTick();

  const secondResult = transport.getLastCommandResults()[0];
  assert.equal(secondResult.kind, "rejected");
  assert.equal(secondResult.code, "tool");
  const clientWorldAfterSecond = transport.getClientWorld();
  assert.equal(clientWorldAfterSecond.players[actorId].hotbar[0].kind, "empty");
  assert.equal(clientWorldAfterSecond.worldRevision, worldRevisionAfterFirst);
  assert.equal(clientWorldAfterSecond.players[actorId].inventoryRevision, inventoryRevisionAfterFirst);
  assert.equal(clientWorldAfterSecond.grid.get(10, 10), MaterialId.Faucet);
});

test("LocalTransport isolates client state objects and does not expose authority accessors", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);

  const firstState = transport.getClientState();
  firstState.clientWorld.players[actorId].input.left = true;
  const secondState = transport.getClientState();

  assert.equal(secondState.clientWorld.players[actorId].input.left, false);
  assert.equal(typeof transport.getClientWorld, "function");
  assert.equal(typeof transport.getClientSnapshot, "function");
  assert.equal("getAuthoritativeWorld" in transport, false);
  assert.equal("createEditorAccess" in transport, false);
});

test("LocalTransport binds owner-only commands to the local actor and rejects stale revisions without mutating authority", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const clientWorldBefore = transport.getClientWorld();

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: clientWorldBefore.worldRevision + 1 });
  transport.advanceTick();

  const results = transport.getLastCommandResults();
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "rejected");
  assert.equal(results[0].code, "revision");
  assert.equal(transport.getClientWorld().paused, false);
  assert.equal(transport.getClientWorld().worldRevision, clientWorldBefore.worldRevision);
});

test("LocalTransport clears the brush stack when it is fully consumed and preserves positive counts for partial consumption", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Sand, count: 2 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const fullStackResult = transport.getLastCommandResults()[0];
  assert.equal(fullStackResult.kind, "accepted");
  assert.equal(world.players[actorId].hotbar[0].kind, "material");
  assert.equal(transport.getClientWorld().players[actorId].hotbar[0].kind, "empty");

  const partialWorld = createDefaultWorldState("room_transport_partial");
  const partialActorId = createPlayerId("player_transport_partial");
  partialWorld.players[partialActorId] = createDefaultPlayerState(partialActorId);
  const partialPlayer = partialWorld.players[partialActorId];
  partialPlayer.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Sand, count: 5 }
    : { kind: "empty" });
  partialPlayer.activeHotbarSlot = 0;

  const { transport: partialTransport } = createLocalTransportSession(partialWorld, partialActorId);

  partialTransport.enqueueCommand({
    type: "place",
    x: 0,
    y: 0,
    brushRadius: 1,
    expectedInventoryRevision: partialPlayer.inventoryRevision,
    expectedAnchorRevision: partialWorld.grid.cellRevisions[partialWorld.grid.index(10, 10)] ?? 0,
  });
  partialTransport.advanceTick();

  const partialResult = partialTransport.getLastCommandResults()[0];
  assert.equal(partialResult.kind, "accepted");
  const partialClientPlayer = partialTransport.getClientWorld().players[partialActorId];
  assert.equal(partialClientPlayer.hotbar[0].kind, "material");
  assert.ok(partialClientPlayer.hotbar[0].count > 0);
  assert.equal(partialWorld.players[partialActorId].hotbar[0].kind, "material");
});

test("LocalTransport rejects owner-only pause and time commands for a different bound actor without authority mutation", () => {
  const ownerActorId = createPlayerId("player_transport_owner");
  const boundActorId = createPlayerId("player_transport_bound");
  const world = createDefaultWorldState("room_transport_owner_mismatch");
  world.ownerPlayerId = ownerActorId;
  world.players[ownerActorId] = createDefaultPlayerState(ownerActorId);
  world.players[boundActorId] = createDefaultPlayerState(boundActorId);
  world.time.dayNightTick = 7;
  world.time.dayNightCycle = 7 / 18000;

  const { transport: pauseTransport } = createLocalTransportSession(world, boundActorId);
  const initialRevision = pauseTransport.getClientWorld().worldRevision;

  pauseTransport.enqueueCommand({ type: "pause_world", expectedWorldRevision: initialRevision });
  pauseTransport.advanceTick();
  const pauseResult = pauseTransport.getLastCommandResults()[0];
  assert.equal(pauseResult.kind, "rejected");
  assert.equal(pauseResult.code, "not_owner");
  assert.equal(pauseTransport.getClientWorld().paused, false);
  assert.equal(pauseTransport.getClientWorld().worldRevision, initialRevision);
  assert.equal(pauseTransport.getClientWorld().ownerPlayerId, ownerActorId);

  const { transport: timeTransport } = createLocalTransportSession(world, boundActorId);
  timeTransport.enqueueCommand({ type: "set_time_preset", preset: "night", expectedWorldRevision: timeTransport.getClientWorld().worldRevision });
  timeTransport.advanceTick();
  const timeResult = timeTransport.getLastCommandResults()[0];
  assert.equal(timeResult.kind, "rejected");
  assert.equal(timeResult.code, "not_owner");
  assert.equal(timeTransport.getClientWorld().time.dayNightTick, 8);
  assert.equal(world.time.dayNightTick, 7);
  assert.equal(world.ownerPlayerId, ownerActorId);
});

test("LocalTransport isolates subscriber callback state and preserves authoritative outcomes", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);

  let firstSubscriberState;
  let secondSubscriberState;

  transport.subscribe((state) => {
    firstSubscriberState = state;
    state.clientWorld.paused = false;
    state.clientWorld.players[actorId].input.left = false;
    state.clientWorld.players[actorId].activeHotbarSlot = 7;
    state.clientWorld.grid.set(0, 0, MaterialId.Sand);
    state.snapshot.worldState.paused = false;
    state.snapshot.worldState.players[actorId].input.left = false;
    state.delta.gridDimensions.width = 999;
    state.lastCommandResults[0].code = "invalid_command";
  });
  transport.subscribe((state) => {
    secondSubscriberState = state;
  });

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();

  assert.equal(firstSubscriberState.clientWorld.paused, false);
  assert.equal(firstSubscriberState.clientWorld.players[actorId].input.left, false);
  assert.equal(firstSubscriberState.clientWorld.players[actorId].activeHotbarSlot, 7);
  assert.equal(firstSubscriberState.clientWorld.grid.get(0, 0), MaterialId.Sand);
  assert.equal(firstSubscriberState.snapshot.worldState.paused, false);
  assert.equal(firstSubscriberState.snapshot.worldState.players[actorId].input.left, false);
  assert.equal(firstSubscriberState.delta.gridDimensions.width, 999);
  assert.equal(firstSubscriberState.lastCommandResults[0].code, "invalid_command");

  assert.equal(secondSubscriberState.clientWorld.paused, true);
  assert.equal(secondSubscriberState.clientWorld.players[actorId].input.left, false);
  assert.equal(secondSubscriberState.clientWorld.players[actorId].activeHotbarSlot, 0);
  assert.equal(secondSubscriberState.clientWorld.grid.get(0, 0), MaterialId.Empty);
  assert.equal(secondSubscriberState.snapshot.worldState.paused, true);
  assert.equal(secondSubscriberState.snapshot.worldState.players[actorId].input.left, false);
  assert.notEqual(secondSubscriberState.delta.gridDimensions.width, 999);
  assert.equal(secondSubscriberState.lastCommandResults[0].code, "accepted");

  assert.equal(transport.getClientWorld().paused, true);
  assert.equal(transport.getClientWorld().players[actorId].input.left, false);
  assert.equal(transport.getClientWorld().players[actorId].activeHotbarSlot, 0);
  assert.equal(transport.getClientWorld().grid.get(0, 0), MaterialId.Empty);
  assert.equal(transport.getClientSnapshot().worldState.paused, true);
  assert.equal(transport.getClientState().lastCommandResults[0].code, "accepted");
});

test("LocalTransport constructor and editor replacement clone their input worlds", () => {
  const initialWorld = createDefaultWorldState("room_transport_alias_constructor");
  const actorId = createPlayerId("player_transport_alias_constructor");
  initialWorld.players[actorId] = createDefaultPlayerState(actorId);

  const { transport, editor } = createLocalTransportSession(initialWorld, actorId);
  initialWorld.players[actorId].input.left = true;
  initialWorld.grid.set(0, 0, MaterialId.Sand);
  initialWorld.time = 99;

  const clientWorld = transport.getClientWorld();
  assert.equal(clientWorld.players[actorId].input.left, false);
  assert.equal(clientWorld.grid.get(0, 0), MaterialId.Empty);
  assert.notEqual(clientWorld.time, 99);

  const replacementWorld = createDefaultWorldState("room_transport_alias_replacement");
  const replacementActorId = createPlayerId("player_transport_alias_replacement");
  replacementWorld.players[replacementActorId] = createDefaultPlayerState(replacementActorId);

  editor.replaceWorld(replacementWorld);
  replacementWorld.players[replacementActorId].input.left = true;
  replacementWorld.grid.set(1, 1, MaterialId.Sand);
  replacementWorld.time = 77;

  const replacedWorld = transport.getClientWorld();
  assert.equal(replacedWorld.players[replacementActorId].input.left, false);
  assert.equal(replacedWorld.grid.get(1, 1), MaterialId.Empty);
  assert.notEqual(replacedWorld.time, 77);
});
