// Fixture "ordinary page with an HTML5 video" for the browser tests (served by Playwright routing at
// https://video.test/v/<id>, https://www.loom.com/share/v-<id> and https://www.youtube.com/watch?v=<id>,
// never by those sites). Runs in the page's main world; tests drive it through window.fixture.
//   ?at=N        the main video starts paused at N s (default 100)
//   ?preview=1   plus a muted, looping, autoplaying preview (a teaser)
//   ?side=1      plus a second video the page starts by itself, with sound
//   ?media=http  the main video comes from /media.wav over http (Range; the test can hold its data)

function silentWav(seconds) {
  const rate = 8000;
  const samples = rate * seconds;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

const params = new URLSearchParams(location.search);
const player = document.getElementById("player");

function makeVideo(id, width, height) {
  const video = document.createElement("video");
  video.id = id;
  video.width = width;
  video.height = height;
  video.preload = "auto";
  return video;
}

/** Loads a new source into the element, paused at `at` once its metadata is there. */
function load(video, src, at) {
  video.src = src;
  video.addEventListener("loadedmetadata", () => (video.currentTime = at), { once: true });
}

const main = makeVideo("main", 640, 360);
load(main, params.get("media") === "http" ? "/media.wav" : silentWav(120), Number(params.get("at") ?? "100"));
player.append(main);
// Like a site player: a click on the video starts or pauses it.
main.addEventListener("click", () => void (main.paused ? main.play() : main.pause()));

if (params.has("preview")) {
  const preview = makeVideo("preview", 200, 112);
  preview.muted = true;
  preview.loop = true;
  preview.autoplay = true;
  preview.src = silentWav(5);
  document.body.append(preview);
}

if (params.has("side")) {
  // The page starts it by itself, with sound: not the user's choice.
  const side = makeVideo("side", 320, 180);
  side.src = silentWav(60);
  side.addEventListener("loadedmetadata", () => void side.play(), { once: true });
  document.body.append(side);
}

window.fixture = {
  state(id = "main") {
    const v = document.getElementById(id);
    return v ? { paused: v.paused, currentTime: v.currentTime, duration: v.duration, muted: v.muted, rate: v.playbackRate, waiting: v.readyState < 3 } : null;
  },
  /** YouTube-style: another video in the same tab and the same element, new address, no reload. */
  next(id, at = 0) {
    history.pushState({}, "", `${location.pathname}?v=${id}`);
    load(main, silentWav(120), at);
  },
  /** Back to an earlier address (and its video). */
  back(id, at = 0) {
    this.next(id, at);
  },
  /** The page's own speed control. */
  setRate(rate) {
    main.playbackRate = rate;
  },
};
