// Sync with video for an ordinary page's result (Loom, YouTube, any page with one HTML5 video): the
// panel offers the Sync control only when this result was made with this page's one video, MyDubb
// can reach the page (activeTab), that video is identified now and the tab's page is linked to the
// player. Otherwise it says why in one line, and the audio is listened to on its own. Pure.

import type { VideoState } from "../shared/messages";
import { syncStatusText, type SyncView } from "../shared/sync";

export type PageAccess = "unknown" | "granted" | "none";

export interface PageSyncInput {
  sync: SyncView;
  /** The tab's page is linked to the player (the hub checked it shows `syncPage`). */
  linked: boolean;
  /** The page the session may sync with; null: the result was not made with a page's video. */
  syncPage: string | null;
  /**
   * What the loaded result's Generate snapshot had, when this panel knows it: a page's video, only
   * source times, or neither.
   */
  made: "with-video" | "without-video" | "without-span" | "unknown";
  /** Whether the extension can reach the tab's page (content script injected). */
  access: PageAccess;
  /** The page shown now (null: not connected to it) and its video. */
  page: string | null;
  video: VideoState | null;
}

export const NO_ACCESS =
  "MyDubb cannot reach this page's video. Click the MyDubb button in Chrome's toolbar on this page, then try again.";

const prefix = (text: string) => `Sync with video is not available: ${text}`;

export function pageSyncState(input: PageSyncInput): { show: boolean; controls: boolean; text: string } {
  const { sync } = input;
  const reason = (text: string) => ({ show: true, controls: false, text });
  // Sync is on: the control stays, to turn it off.
  if (sync.status !== "off" && sync.status !== "unavailable") return { show: true, controls: true, text: "" };
  if (input.syncPage === null) {
    // Said only where it helps: a result with source times, made while no single video was
    // identified, on a page that has a video now (or that MyDubb cannot reach). Anything else, a page
    // without any video included, plays on its own as it always did, without a word.
    const hidden = { show: false, controls: false, text: "" };
    if (input.made !== "without-video") return hidden;
    if (input.page === null) return input.access === "none" ? reason(NO_ACCESS) : hidden;
    if (!input.video || input.video.status === "none") return hidden;
    return reason(
      prefix(
        "no single video was identified on this page when you chose Generate, so this audio plays on its own. To sync, Generate again while the page shows its video.",
      ),
    );
  }
  if (input.page === null) return reason(input.access === "none" ? NO_ACCESS : prefix("connecting to the page…"));
  if (input.page !== input.syncPage) {
    return reason(prefix("the page now shows another video or address than the one this audio was made on. The audio plays on its own."));
  }
  const video = input.video;
  if (!video || video.status === "none") return reason(prefix("no video was found on this page."));
  if (video.status === "ambiguous") {
    return reason(
      prefix(`this page has ${video.candidates} videos and MyDubb cannot tell which one this audio belongs to. Start that video once on the page.`),
    );
  }
  if (sync.status === "unavailable" && sync.unavailable !== "not-linked") return reason(syncStatusText(sync));
  if (!input.linked) return reason(prefix("connecting to the video…"));
  return { show: true, controls: true, text: "" };
}
