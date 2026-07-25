/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialId, createDefaultPlayerState, createDefaultWorldState, createLocalTransportSession, createPlayerId } from "@particle-sim/shared";
import { buildUi } from "./ui";
import { state } from "./state";

describe("ui clear action", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    vi.stubGlobal("requestAnimationFrame", () => 0 as number);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("clears the authoritative world through the injected editor capability and blocks play-mode clears", () => {
    const playerId = createPlayerId("player_ui_clear");
    const world = createDefaultWorldState("ui_clear_room");
    world.players[playerId] = createDefaultPlayerState(playerId);

    const session = createLocalTransportSession(world, playerId);
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "editor";

    const root = document.createElement("div");
    document.body.appendChild(root);
    buildUi(root, session.editor);

    const seededWorld = createDefaultWorldState("ui_clear_seeded");
    seededWorld.players[playerId] = createDefaultPlayerState(playerId);
    seededWorld.grid.set(2, 2, MaterialId.Sand);
    session.editor.replaceWorld(seededWorld);
    expect(session.transport.getClientWorld().grid.get(2, 2)).toBe(MaterialId.Sand);

    const clearButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent === "Clear");
    expect(clearButton).toBeTruthy();
    clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const clearedClientWorld = session.transport.getClientWorld();
    expect(clearedClientWorld.grid.get(2, 2)).toBe(MaterialId.Empty);

    state.toolMode = "play";
    session.editor.mutateWorld((nextWorld) => {
      nextWorld.grid.set(1, 1, MaterialId.Dirt);
    });
    clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(session.transport.getClientWorld().grid.get(1, 1)).toBe(MaterialId.Dirt);
  });
});
