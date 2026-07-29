import { pathToFileURL } from "node:url";
import { parseServerConfig } from "./config.js";
import { createHttpServer } from "./http/router.js";
import { RoomManager } from "./room/room-manager.js";

export interface ProcessAdapter {
  exit(code?: number): never;
  exitCode?: number;
}

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
    reconnectTimeoutMs: config.reconnectTimeoutMs,
    reconnectTombstoneLimit: config.reconnectTombstoneLimit,
  });
  const server = createHttpServer({ config, roomManager });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  return { server, roomManager };
}

export async function stopServer(
  server: ReturnType<typeof createHttpServer>,
  roomManager: RoomManager,
  graceMs = 2_000,
  processAdapter: ProcessAdapter = process as unknown as ProcessAdapter,
): Promise<void> {
  const roomShutdownPromise = roomManager.shutdown(graceMs);
  const serverClosePromise = closeHttpServer(server);

  const timedOut = await new Promise<boolean>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      resolve(true);
    }, graceMs);

    Promise.allSettled([roomShutdownPromise, serverClosePromise]).then(() => {
      clearTimeout(timeoutHandle);
      resolve(false);
    });
  });

  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }

  const settled = await Promise.allSettled([roomShutdownPromise, serverClosePromise]);
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  if (timedOut || failures.length > 0) {
    processAdapter.exitCode = 1;
    throw new AggregateError(failures, "server shutdown failed");
  }
}

export function createShutdownHandler(
  server: ReturnType<typeof createHttpServer>,
  roomManager: RoomManager,
  config: ReturnType<typeof parseServerConfig>,
  processAdapter: ProcessAdapter = process as unknown as ProcessAdapter,
): () => Promise<void> {
  return async () => {
    try {
      await stopServer(server, roomManager, config.defaultShutdownGraceMs, processAdapter);
    } catch (error) {
      processAdapter.exitCode = 1;
      console.error(error);
    } finally {
      processAdapter.exit(processAdapter.exitCode ?? 0);
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = parseServerConfig();
  const { server, roomManager } = await startServer(config);
  const shutdown = createShutdownHandler(server, roomManager, config);
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
