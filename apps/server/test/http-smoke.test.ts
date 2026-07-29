import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { parseServerConfig } from "../src/config.js";
import { createHttpServer } from "../src/http/router.js";
import { RoomManager } from "../src/room/room-manager.js";

function request(server: ReturnType<typeof createHttpServer>, path: string, method = "GET") {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        path,
        method,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("healthz and room creation respond over http", async () => {
  const config = parseServerConfig({
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
  });
  const roomManager = new RoomManager({
    maxRooms: 4,
    minCapacity: 2,
    maxCapacity: 2,
    tickHz: 60,
    maxCatchUpTicks: 2,
    idleCleanupThresholdMs: 100,
  });
  const server = createHttpServer({ config, roomManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const health = await request(server, config.healthPath);
    assert.equal(health.statusCode, 200);
    const payload = JSON.parse(health.body);
    assert.equal(payload.status, "ready");

    const created = await request(server, config.roomsPath, "POST");
    assert.equal(created.statusCode, 201);
    const roomPayload = JSON.parse(created.body);
    assert.equal(roomPayload.joinAccepted, true);
    assert.equal(roomPayload.memberships.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await roomManager.shutdown(0);
  }
});
