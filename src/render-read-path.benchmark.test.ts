import { describe, expect, it } from "vitest";
import { createLocalTransportSession, createPlayerId, createStarterWorld } from "@particle-sim/shared";
import { createPresentationSnapshot } from "./render-snapshots";

describe("render read path benchmark", () => {
  it("measures presentation snapshot creation from the latest published world versus transport restore", { timeout: 20000 }, () => {
    const world = createStarterWorld({ roomId: "render_path_benchmark" });
    const playerId = createPlayerId("player_1");
    const session = createLocalTransportSession(world, playerId);
    const transport = session.transport;

    let latestPublishedWorld = transport.getClientWorld();
    transport.subscribe((view) => {
      latestPublishedWorld = view.clientWorld;
    });

    for (let tick = 0; tick < 3; tick += 1) {
      transport.advanceTick();
    }

    const iterations = 40;

    let restoreMs = 0;
    let publishedMs = 0;

    const restoreStart = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      createPresentationSnapshot(transport.getClientWorld());
    }
    const restoreEnd = performance.now();
    restoreMs = restoreEnd - restoreStart;

    const publishedStart = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      createPresentationSnapshot(latestPublishedWorld);
    }
    const publishedEnd = performance.now();
    publishedMs = publishedEnd - publishedStart;

    console.info(`[render-read-path] restore=${restoreMs.toFixed(3)}ms published=${publishedMs.toFixed(3)}ms ratio=${(publishedMs / Math.max(restoreMs, 1e-6)).toFixed(3)}`);

    expect(restoreMs).toBeGreaterThan(0);
    expect(publishedMs).toBeGreaterThan(0);
  });
});
