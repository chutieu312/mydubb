// Test helper: a real <video> element (jsdom) with controllable media properties.

export interface FakeMedia {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  networkState: number;
  seekable: [number, number][];
  error: { code: number } | null;
  playImpl: () => Promise<void>;
  /** Runs after currentTime is set: what the seek does (fires "seeked", lands elsewhere...). */
  seekOutcome?: (video: HTMLVideoElement) => void;
}

export function fakeVideo(doc: Document, init: Partial<FakeMedia> = {}): HTMLVideoElement & { media: FakeMedia } {
  const video = doc.createElement("video") as HTMLVideoElement & { media: FakeMedia };
  const media: FakeMedia = {
    paused: true,
    ended: false,
    currentTime: 0,
    duration: 100,
    readyState: 4,
    networkState: 1,
    seekable: [[0, 100]],
    error: null,
    playImpl: async () => undefined,
    ...init,
  };
  video.media = media;
  const prop = (name: keyof FakeMedia, set?: (v: never) => void) =>
    Object.defineProperty(video, name, { configurable: true, get: () => media[name], set });
  prop("paused");
  prop("ended");
  prop("duration");
  prop("readyState");
  prop("networkState");
  prop("error");
  prop("currentTime", (v: number) => {
    media.currentTime = v;
    if (media.seekOutcome) media.seekOutcome(video);
  });
  Object.defineProperty(video, "seekable", {
    configurable: true,
    get: () => ({
      length: media.seekable.length,
      start: (i: number) => media.seekable[i]![0],
      end: (i: number) => media.seekable[i]![1],
    }),
  });
  video.play = async () => {
    await media.playImpl();
    media.paused = false;
    video.dispatchEvent(new Event("play"));
  };
  video.pause = () => {
    media.paused = true;
    video.dispatchEvent(new Event("pause"));
  };
  return video;
}
