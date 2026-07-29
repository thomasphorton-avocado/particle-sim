import { pathToFileURL } from "node:url";
import { parseServerConfig } from "./config.js";
import { createHttpServer } from "./http/router.js";
import { RoomManager } from "./room/room-manager.js";

function closeHttpServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

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

export async function stopServer(server: ReturnType<typeof createHttpServer>, roomManager: RoomManager, graceMs = 2_000): Promise<void> {
  const roomShutdownPromise = roomManager.shutdown(graceMs).catch((error) => {
    throw error;
  });
  const serverClosePromise = closeHttpServer(server).catch((error) => {
    throw error;
  });

  const completed = await Promise.race([
    Promise.allSettled([roomShutdownPromise, serverClosePromise]).then(() => false),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), graceMs);
    }),
  ]);

  if (completed) {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
  }

  await Promise.allSettled([roomShutdownPromise, serverClosePromise]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = parseServerConfig();
  const { server, roomManager } = await startServer(config);
  const shutdown = async () => {
    try {
      await stopServer(server, roomManager, config.defaultShutdownGraceMs);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
