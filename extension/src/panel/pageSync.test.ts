import { describe, expect, it } from "vitest";

import type { VideoState } from "../shared/messages";
import type { SyncView } from "../shared/sync";
import { NO_ACCESS, pageSyncState, type PageSyncInput } from "./pageSync";

const PAGE = "p-0123456789abcd";
const OFF: SyncView = { status: "off", unavailable: null, start: 19, end: 83, duration: 64, rate: 1, confirmed: false, notice: null };
const READY: VideoState = {
  status: "ready",
  id: 1,
  paused: true,
  ended: false,
  currentTime: 40,
  duration: 300,
  seekStart: 0,
  seekEnd: 300,
  readyState: 4,
  waiting: false,
  error: null,
};
const good: PageSyncInput = { sync: OFF, linked: true, syncPage: PAGE, made: "with-video", access: "granted", page: PAGE, video: READY };
const state = (over: Partial<PageSyncInput>) => pageSyncState({ ...good, ...over });

describe("Sync on an ordinary page", () => {
  it("offers the control only with the result's page, its one video and the link", () => {
    expect(state({})).toEqual({ show: true, controls: true, text: "" });
    expect(state({ linked: false })).toMatchObject({ controls: false, text: expect.stringMatching(/connecting to the video/) });
    expect(state({ page: "p-fedcba98765432" })).toMatchObject({ controls: false, text: expect.stringMatching(/another video or address/) });
    expect(state({ video: { status: "none" } })).toMatchObject({ controls: false, text: expect.stringMatching(/no video was found/) });
    expect(state({ video: { status: "ambiguous", candidates: 3 } })).toMatchObject({
      controls: false,
      text: expect.stringMatching(/3 videos .* Start that video once on the page/),
    });
  });

  it("without access to the page, tells the user to click the MyDubb button", () => {
    expect(state({ page: null, video: null, linked: false, access: "none" })).toEqual({ show: true, controls: false, text: NO_ACCESS });
    expect(state({ page: null, video: null, linked: false, access: "unknown" }).text).toMatch(/connecting to the page/);
  });

  it("keeps the control while Sync is on, whatever the page reports", () => {
    expect(state({ sync: { ...OFF, status: "playing" }, linked: false, video: { status: "none" } })).toMatchObject({ controls: true });
  });

  it("the mapping's own reasons (length, speed) come before the link", () => {
    const sync: SyncView = { ...OFF, status: "unavailable", unavailable: "length-mismatch" };
    expect(state({ sync, linked: false }).text).toMatch(/MP3 length does not match/);
  });

  it("a result made without the page's video: one line where it helps, otherwise nothing", () => {
    const none = { syncPage: null, linked: false };
    expect(state({ ...none, made: "without-video" })).toMatchObject({ show: true, controls: false, text: expect.stringMatching(/no single video was identified/) });
    expect(state({ ...none, made: "without-span" }).show).toBe(false);
    expect(state({ ...none, made: "unknown" }).show).toBe(false);
    // A page without any video, or not reached yet: nothing to say.
    expect(state({ ...none, made: "without-video", video: { status: "none" } }).show).toBe(false);
    expect(state({ ...none, made: "without-video", page: null, video: null }).show).toBe(false);
    // A page MyDubb cannot reach: how to give it access.
    expect(state({ ...none, made: "without-video", page: null, video: null, access: "none" })).toMatchObject({ show: true, text: NO_ACCESS });
  });
});
