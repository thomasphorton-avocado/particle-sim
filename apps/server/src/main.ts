import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { parseServerConfig } from "./config.js";
import { createHttpServer } from "./http/router.js";
import { RoomManager } from "./room/room-manager.js";

export async function startServer(config = parseServerConfig()): Promise<{ server: ReturnType<typeof createHttpServer>; roomManager: RoomManager }> {
  const roomManager = new RoomManager({
    maxRooms: config.maxRooms,
    minCapacity: config.minCapacity,
    maxCapacity: config.maxCapacity,
    tickHz: config.tickHz,
    maxCatchUpTicks: config.maxCatchUpTicks,
    idleCleanupThresholdMs: config.idleCleanupThresholdMs,
  });
  const server = createHttpServer({ config, roomManager });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  return { server, roomManager };
}

export async function stopServer(server: ReturnType<typeof createHttpServer>, roomManager: RoomManager): Promise<void> {
  await roomManager.shutdown();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = parseServerConfig();
  const { server, roomManager } = await startServer(config);
  const shutdown = async () => {
    await stopServer(server, roomManager);
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
  await once(server, "listening");
}
