import { createServer, type ServerResponse } from "node:http";
import type { ServerConfig } from "../config.js";
import { HttpRouteError } from "../errors.js";
import type { RoomManager } from "../room/room-manager.js";

export interface HttpServerDependencies {
  readonly config: ServerConfig;
  readonly roomManager: RoomManager;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function createHttpServer(dependencies: HttpServerDependencies) {
  const { config, roomManager } = dependencies;
  return createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 400, { error: { code: "invalid_request", message: "request URL is missing" } });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
      if (request.method === "GET" && url.pathname === config.healthPath) {
        const lifecycle = roomManager.lifecycle;
        sendJson(response, 200, {
          status: lifecycle.ready ? "ready" : lifecycle.shuttingDown ? "shutting_down" : "admission_closed",
          ready: lifecycle.ready,
          admitting: lifecycle.admissionOpen,
          shuttingDown: lifecycle.shuttingDown,
          rooms: roomManager.roomCount,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === config.roomsPath) {
        const room = await roomManager.createRoom();
        const joinResult = room.enqueueJoin({
          sessionId: `session_${room.roomId}`,
          connectionId: `conn_${room.roomId}`,
          connectionOrdinal: 1,
          generation: 1,
        });
        await room.flushPendingIngresses();
        sendJson(response, 201, {
          roomId: room.roomId,
          memberships: room.memberships,
          ownerPlayerId: room.state.ownerPlayerId,
          joinAccepted: joinResult.accepted,
        });
        return;
      }

      throw new HttpRouteError(404, "not_found", "route not found");
    } catch (error) {
      if (error instanceof HttpRouteError) {
        sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
        return;
      }
      sendJson(response, 500, { error: { code: "internal_error", message: "an unexpected error occurred" } });
    }
  });
}
