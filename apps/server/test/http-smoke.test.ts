import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { parseServerConfig } from "../src/config.js";
import { createHttpServer } from "../src/http/router.js";
import { RoomManager } from "../src/room/room-manager.js";

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function request(server: ReturnType<typeof createHttpServer>, path: string, options: RequestOptions = {}) {
  const { method = "GET", headers = {}, body } = options;
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function createTestServer() {
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
  return { server, config, roomManager };
}

test("healthz and room creation respond over http", async () => {
  const { server, config, roomManager } = await createTestServer();
  try {
    const health = await request(server, config.healthPath);
    assert.equal(health.statusCode, 200);
    const payload = JSON.parse(health.body);
    assert.equal(payload.status, "ready");

    const created = await request(server, config.roomsPath, { method: "POST", headers: { "content-type": "application/json" } });
    assert.equal(created.statusCode, 201);
    const roomPayload = JSON.parse(created.body);
    assert.equal(roomPayload.joinAccepted, false);
    assert.equal(roomPayload.memberships.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await roomManager.shutdown(0);
  }
});

test("http boundary rejects unsupported methods and malformed bodies", async () => {
  const { server, config, roomManager } = await createTestServer();
  try {
    const badMethod = await request(server, config.healthPath, { method: "POST" });
    assert.equal(badMethod.statusCode, 405);

    const badRoomsMethod = await request(server, config.roomsPath, { method: "GET" });
    assert.equal(badRoomsMethod.statusCode, 405);

    const wrongContentType = await request(server, config.roomsPath, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongContentType.statusCode, 415);

    const malformedJson = await request(server, config.roomsPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(malformedJson.statusCode, 400);

    const unknownFields = await request(server, config.roomsPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    assert.equal(unknownFields.statusCode, 400);

    const oversizedBody = await request(server, config.roomsPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2048),
    });
    assert.equal(oversizedBody.statusCode, 413);

    const notFound = await request(server, "/missing", { method: "GET" });
    assert.equal(notFound.statusCode, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await roomManager.shutdown(0);
  }
});

test("http boundary rejects jsonp and allows a charset parameter", async () => {
  const { server, config, roomManager } = await createTestServer();
  try {
    const jsonp = await request(server, config.roomsPath, {
      method: "POST",
      headers: { "content-type": "application/jsonp" },
      body: "{}",
    });
    assert.equal(jsonp.statusCode, 415);

    const charset = await request(server, config.roomsPath, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{}",
    });
    assert.equal(charset.statusCode, 201);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await roomManager.shutdown(0);
  }
});
