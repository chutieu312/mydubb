// Fixture "Udemy lecture" page for the browser tests (served by Playwright routing, never by
// udemy.com). Runs in the page's main world; tests drive it through window.fixture.

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
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true); // 8-bit
  text(36, "data");
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128); // silence
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

const player = document.getElementById("player");

function makeVideo(seconds = 30) {
  const video = document.createElement("video");
  video.src = silentWav(seconds);
  video.preload = "auto";
  video.width = 320;
  video.height = 180;
  return video;
}

function videos() {
  return [...document.querySelectorAll("video")];
}

window.fixture = {
  videos,
  replaceVideo(seconds = 30) {
    videos().forEach((v) => v.remove());
    player.append(makeVideo(seconds));
  },
  /** Udemy-style SPA navigation to another lecture: URL, title and player change, no reload. */
  navigate(lectureId) {
    history.pushState({}, "", `/course/demo-course/learn/lecture/${lectureId}`);
    document.title = `Lecture ${lectureId} | Demo Course | Udemy`;
    this.replaceVideo(20);
  },
  state(index = 0) {
    const v = videos()[index];
    return v ? { paused: v.paused, currentTime: v.currentTime, duration: v.duration, muted: v.muted, volume: v.volume, rate: v.playbackRate } : null;
  },
};

const params = new URLSearchParams(location.search);
const count = Number(params.get("videos") ?? "1");
// ?seconds=N: a longer lecture video (the sync tests need room for the job's span).
const seconds = Number(params.get("seconds") ?? "30");
for (let i = 0; i < count; i += 1) player.append(makeVideo(seconds));
