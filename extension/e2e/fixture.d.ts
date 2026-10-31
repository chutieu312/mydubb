// Shape of the fixture page's window.fixture (e2e/fixtures/fixture.js).
interface FixtureVideoState {
  paused: boolean;
  currentTime: number;
  duration: number;
  muted: boolean;
  volume: number;
  rate: number;
}

interface Window {
  fixture: {
    videos(): HTMLVideoElement[];
    replaceVideo(seconds?: number): void;
    navigate(lectureId: number): void;
    siteResetsRate(on: "play" | "playing" | "seeked" | "ratechange" | null, rate?: number, times?: number): void;
    siteResets(): number;
    state(index?: number): FixtureVideoState | null;
  };
}
