import { pathToFileURL } from "node:url";
import { parseServerConfig } from "./config.js";
import { createHttpServer } from "./http/router.js";
import { RoomManager } from "./room/room-manager.js";

export interface ProcessAdapter {
  exit(code?: number): never;
  exitCode?: number;
}

export interface ServerHandle {
  readonly server: ReturnType<typeof createHttpServer>;
  readonly roomManager: RoomManager;
  readonly stop: () => Promise<void>;
}

function closeHttpServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startServer(config = parseServerConfig()): Promise<ServerHandle> {
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

  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = stopServer(server, roomManager, config.defaultShutdownGraceMs, process as unknown as ProcessAdapter);
    return stopPromise;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("error", onError);
        void cleanupStartServerResources(server, roomManager).catch(() => undefined);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.listen(config.port, config.host, onListening);
    });
  } catch (error) {
    await cleanupStartServerResources(server, roomManager);
    throw error;
  }

  return { server, roomManager, stop };
}

async function cleanupStartServerResources(server: ReturnType<typeof createHttpServer>, roomManager: RoomManager): Promise<void> {
  await closeHttpServer(server).catch(() => undefined);
  await roomManager.shutdown(0).catch(() => undefined);
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
