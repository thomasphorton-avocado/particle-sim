import test from "node:test";
import assert from "node:assert/strict";
import { MaterialId, createCommandEnvelope, createDefaultPlayerState, createDefaultWorldState, createObjectId, createPlayerId, processCommand } from "@particle-sim/shared";

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

test("out-of-bounds commands are rejected without mutating state", () => {
  const { world, actorId } = createWorldWithPlayer();
  const worldRevision = world.worldRevision;
  const inventoryRevision = world.players[actorId].inventoryRevision;
  const envelope = createCommandEnvelope(actorId, 1, 0, { type: "harvest", x: -1, y: 0, expectedTargetRevision: 0 });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "rejected");
  assert.equal(result.code, "bounds");
  assert.equal(world.worldRevision, worldRevision);
  assert.equal(world.players[actorId].inventoryRevision, inventoryRevision);
});

test("cycle_faucet propagates to every faucet cell in the object without touching malformed peers", () => {
  const { world, actorId } = createWorldWithPlayer();
  const faucetObjectId = createObjectId("object_faucet");
  world.grid.set(1, 1, MaterialId.Faucet, { objectId: faucetObjectId });
  world.grid.setFaucetFlow(1, 1, 0);
  world.grid.set(2, 1, MaterialId.Faucet, { objectId: faucetObjectId });
  world.grid.setFaucetFlow(2, 1, 0);
  world.grid.set(3, 1, MaterialId.Wall, { objectId: faucetObjectId });

  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "cycle_faucet",
    x: 1,
    y: 1,
    objectId: faucetObjectId,
    expectedTargetRevision: world.grid.cellRevisions[world.grid.index(1, 1)] ?? 0,
  });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "accepted");
  assert.equal(world.grid.getFaucetFlow(1, 1), 1);
  assert.equal(world.grid.getFaucetFlow(2, 1), 1);
  assert.equal(world.grid.get(3, 1), MaterialId.Wall);
  assert.equal(world.grid.getObjectId(3, 1), faucetObjectId);
});

test("cycle_faucet rejects stale revisions without mutating flow state", () => {
  const { world, actorId } = createWorldWithPlayer();
  const faucetObjectId = createObjectId("object_faucet_stale");
  world.grid.set(1, 1, MaterialId.Faucet, { objectId: faucetObjectId });
  world.grid.setFaucetFlow(1, 1, 0);

  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "cycle_faucet",
    x: 1,
    y: 1,
    objectId: faucetObjectId,
    expectedTargetRevision: 999,
  });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "rejected");
  assert.equal(result.code, "revision");
  assert.equal(world.grid.getFaucetFlow(1, 1), 0);
});

test("cycle_faucet rejects forged object ids without mutating flow state", () => {
  const { world, actorId } = createWorldWithPlayer();
  const faucetObjectId = createObjectId("object_faucet_forged");
  world.grid.set(1, 1, MaterialId.Faucet, { objectId: faucetObjectId });
  world.grid.setFaucetFlow(1, 1, 0);

  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "cycle_faucet",
    x: 1,
    y: 1,
    objectId: createObjectId("object_faucet_other"),
    expectedTargetRevision: world.grid.cellRevisions[world.grid.index(1, 1)] ?? 0,
  });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "rejected");
  assert.equal(result.code, "target");
  assert.equal(world.grid.getFaucetFlow(1, 1), 0);
});

test("cycle_faucet rejects when the membership index is empty despite the target cell carrying the object id", () => {
  const { world, actorId } = createWorldWithPlayer();
  const faucetObjectId = createObjectId("object_faucet_missing_membership");
  const beforeWorldRevision = world.worldRevision;
  const beforeInventoryRevision = world.players[actorId].inventoryRevision;
  const beforeAuthorityOrder = world.nextAuthorityOrder;
  world.grid.set(1, 1, MaterialId.Faucet, { objectId: faucetObjectId });
  world.grid.setFaucetFlow(1, 1, 0);
  world.grid.objectCellIndex.clear();

  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "cycle_faucet",
    x: 1,
    y: 1,
    objectId: faucetObjectId,
    expectedTargetRevision: world.grid.cellRevisions[world.grid.index(1, 1)] ?? 0,
  });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "rejected");
  assert.equal(result.code, "target");
  assert.equal(world.grid.getFaucetFlow(1, 1), 0);
  assert.equal(world.worldRevision, beforeWorldRevision);
  assert.equal(world.players[actorId].inventoryRevision, beforeInventoryRevision);
  assert.equal(world.nextAuthorityOrder, beforeAuthorityOrder);
});

test("cycle_faucet rejects when the membership index omits the targeted cell", () => {
  const { world, actorId } = createWorldWithPlayer();
  const faucetObjectId = createObjectId("object_faucet_missing_target");
  const beforeWorldRevision = world.worldRevision;
  const beforeInventoryRevision = world.players[actorId].inventoryRevision;
  const beforeAuthorityOrder = world.nextAuthorityOrder;
  world.grid.set(1, 1, MaterialId.Faucet, { objectId: faucetObjectId });
  world.grid.setFaucetFlow(1, 1, 0);
  world.grid.set(2, 1, MaterialId.Faucet, { objectId: faucetObjectId });
  world.grid.setFaucetFlow(2, 1, 0);
  const targetIndex = world.grid.index(1, 1);
  const peerIndex = world.grid.index(2, 1);
  const cells = world.grid.objectCellIndex.get(faucetObjectId);
  assert.ok(cells);
  cells.delete(targetIndex);
  assert.equal(cells.has(peerIndex), true);

  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "cycle_faucet",
    x: 1,
    y: 1,
    objectId: faucetObjectId,
    expectedTargetRevision: world.grid.cellRevisions[targetIndex] ?? 0,
  });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "rejected");
  assert.equal(result.code, "target");
  assert.equal(world.grid.getFaucetFlow(1, 1), 0);
  assert.equal(world.grid.getFaucetFlow(2, 1), 0);
  assert.equal(world.worldRevision, beforeWorldRevision);
  assert.equal(world.players[actorId].inventoryRevision, beforeInventoryRevision);
  assert.equal(world.nextAuthorityOrder, beforeAuthorityOrder);
});

test("rejected placement preserves inventory and leaves no partial writes", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = [
    { kind: "pickaxe" },
    { kind: "material", materialId: MaterialId.Sand, count: 2 },
    ...Array(8).fill({ kind: "empty" }),
  ];
  player.activeHotbarSlot = 1;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx * dx + dy * dy > 1) continue;
      world.grid.set(10 + dx, 10 + dy, MaterialId.Wall);
    }
  }

  const beforeCount = player.hotbar[1].count;
  const beforeCell = world.grid.get(10, 10);
  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });

  const result = processCommand(world, envelope);

  assert.equal(result.kind, "rejected");
  assert.equal(result.code, "bounds");
  assert.equal(player.hotbar[1].count, beforeCount);
  assert.equal(world.grid.get(10, 10), beforeCell);
  assert.equal(player.inventoryRevision, 0);
});

test("replaying the same accepted command produces the same world-state result", () => {
  const worldA = createDefaultWorldState("room_replay_a");
  const worldB = createDefaultWorldState("room_replay_b");
  const actorId = createPlayerId("player_replay");
  worldA.players[actorId] = createDefaultPlayerState(actorId);
  worldB.players[actorId] = createDefaultPlayerState(actorId);

  const envelope = createCommandEnvelope(actorId, 1, 0, {
    type: "set_input_state",
    left: true,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
  });

  const first = processCommand(worldA, envelope);
  const second = processCommand(worldB, envelope);

  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  assert.equal(worldA.players[actorId].input.left, true);
  assert.equal(worldB.players[actorId].input.left, true);
  assert.equal(worldA.worldRevision, worldB.worldRevision);
  assert.equal(worldA.players[actorId].inventoryRevision, worldB.players[actorId].inventoryRevision);
});
