// Mirrors the backend format for instant feedback only. The backend is authoritative
// for validation and for the target duration it stores.
const TIMESTAMP_RE = /^(\d{2,}):([0-5]\d):([0-5]\d)$/;

export function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP_RE.exec(value.trim());
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

export function formatSeconds(total: number): string {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function previewTargetDuration(first: string, last: string): number | null {
  const a = parseTimestamp(first);
  const b = parseTimestamp(last);
  if (a === null || b === null || b <= a) return null;
  return b - a;
}
