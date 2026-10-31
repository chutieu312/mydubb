import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerView } from "../shared/playback";
import { FloatingPlayer, clampBox, type FloatingActions } from "./floating";

const VIEW: PlayerView = {
  sessionId: "s1",
  lessonKey: "demo-course/1",
  status: "ready",
  paused: true,
  ended: false,
  currentTime: 12,
  duration: 180,
  problem: null,
  choices: { languageLabel: "Vietnamese", voiceLabel: "<b>Andrew</b>", speed: 1.5 },
  floating: true,
};

let actions: { command: ReturnType<typeof vi.fn<FloatingActions["command"]>>; close: ReturnType<typeof vi.fn<FloatingActions["close"]>> };

/** jsdom cannot make a trusted event; the real check (event.isTrusted) is the default. */
function make(trust: (event: Event) => boolean = () => true) {
  const player = new FloatingPlayer(document, window, actions, "open", trust);
  player.render(VIEW);
  const root = document.querySelector("mydubb-player")!.shadowRoot!;
  const button = (label: RegExp) =>
    [...root.querySelectorAll("button")].find((b) => label.test(b.getAttribute("aria-label") ?? ""))!;
  return { player, root, button };
}

const trusted = <T extends Event>(event: T): T => event;

beforeEach(() => {
  actions = { command: vi.fn<FloatingActions["command"]>(), close: vi.fn<FloatingActions["close"]>() };
});

afterEach(() => {
  document.documentElement.querySelectorAll("mydubb-player").forEach((el) => el.remove());
});

describe("clampBox", () => {
  it("keeps the box inside the viewport, with a margin when there is room", () => {
    expect(clampBox(-50, -50, 200, 100, 1000, 700)).toEqual({ x: 8, y: 8 });
    expect(clampBox(5000, 5000, 200, 100, 1000, 700)).toEqual({ x: 792, y: 592 });
    expect(clampBox(300, 200, 200, 100, 1000, 700)).toEqual({ x: 300, y: 200 });
    // A viewport barely larger than the box: no margin, still inside.
    expect(clampBox(50, 50, 200, 100, 205, 104)).toEqual({ x: 5, y: 4 });
  });
});

describe("FloatingPlayer", () => {
  it("appears only when the view asks for it, with the file's choices as text", () => {
    const player = new FloatingPlayer(document, window, actions, "open");
    player.render({ ...VIEW, floating: false });
    expect(document.querySelector("mydubb-player")).toBeNull();
    player.render(VIEW);
    const root = document.querySelector("mydubb-player")!.shadowRoot!;
    expect(root.querySelector(".info")!.textContent).toBe("Vietnamese · <b>Andrew</b> · 1.5x");
    expect(root.querySelector(".info b")).toBeNull();
    expect(root.querySelector(".time")!.textContent).toBe("0:12 / 3:00");
    expect(root.querySelector("[role=region]")!.getAttribute("aria-label")).toBe("MyDubb audio player");
    player.render({ ...VIEW, floating: false });
    expect(document.querySelector("mydubb-player")).toBeNull();
  });

  it("ignores events a page script dispatches (untrusted)", () => {
    const player = new FloatingPlayer(document, window, actions, "open");
    player.render(VIEW);
    const root = document.querySelector("mydubb-player")!.shadowRoot!;
    for (const b of root.querySelectorAll("button")) b.dispatchEvent(new MouseEvent("click"));
    const seek = root.querySelector<HTMLInputElement>(".seek")!;
    seek.value = "100";
    seek.dispatchEvent(new Event("change"));
    expect(actions.command).not.toHaveBeenCalled();
    expect(actions.close).not.toHaveBeenCalled();
    expect(document.querySelector("mydubb-player")).not.toBeNull();
  });

  it("sends commands for real clicks", () => {
    const { button } = make();
    button(/^Play MyDubb/).dispatchEvent(trusted(new MouseEvent("click")));
    button(/^Back 5/).dispatchEvent(trusted(new MouseEvent("click")));
    button(/^Forward 5/).dispatchEvent(trusted(new MouseEvent("click")));
    expect(actions.command.mock.calls.map((c) => c[0])).toEqual([
      { command: "play" },
      { command: "seek-by", value: -5 },
      { command: "seek-by", value: 5 },
    ]);
  });

  it("seeks once the slider is released, without the view jumping back meanwhile", () => {
    const { player, root } = make();
    const seek = root.querySelector<HTMLInputElement>(".seek")!;
    seek.value = "90";
    seek.dispatchEvent(trusted(new Event("input")));
    player.render({ ...VIEW, currentTime: 13 });
    expect(seek.value).toBe("90");
    expect(root.querySelector(".time")!.textContent).toBe("1:30 / 3:00");
    seek.dispatchEvent(trusted(new Event("change")));
    expect(actions.command).toHaveBeenCalledWith({ command: "seek-to", value: 90 });
  });

  it("collapses the UI only, and Close tells the session and hides", () => {
    const { root, button } = make();
    const collapse = button(/^Collapse/);
    collapse.dispatchEvent(trusted(new MouseEvent("click")));
    expect(root.querySelector<HTMLElement>(".body")!.hidden).toBe(true);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(actions.command).not.toHaveBeenCalled();
    button(/^Close/).dispatchEvent(trusted(new MouseEvent("click")));
    expect(actions.close).toHaveBeenCalledTimes(1);
    expect(document.querySelector("mydubb-player")).toBeNull();
  });

  it("shows a problem and disables playback controls until the audio is ready", () => {
    const { player, root, button } = make();
    player.render({ ...VIEW, status: "loading", duration: null });
    expect(button(/^Back 5/).disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>(".seek")!.disabled).toBe(true);
    expect(root.querySelector(".status")!.textContent).toBe("Loading the audio…");
    player.render({ ...VIEW, problem: "play-blocked" });
    expect(root.querySelector(".status")!.textContent).toMatch(/blocked/);
    player.render({ ...VIEW, paused: false });
    expect(button(/^Pause MyDubb/).textContent).toBe("Pause");
  });

  it("keeps the host's placement against page styles", () => {
    make();
    const host = document.querySelector<HTMLElement>("mydubb-player")!;
    expect(host.style.getPropertyValue("position")).toBe("fixed");
    expect(host.style.getPropertyPriority("position")).toBe("important");
  });
});
