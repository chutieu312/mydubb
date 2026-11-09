// Identity of a Udemy lecture page, derived only from the URL path.

export const UDEMY_ORIGIN = "https://www.udemy.com";

/**
 * The source key of a tab that shows no Udemy lecture (Loom, any ordinary web page, a Udemy page
 * that is not a lecture): its transcript is pasted or selected by hand and its audio plays on its
 * own, with no video of the page. A lecture key is always "<slug>/<id>", so this can never equal one.
 */
export const PAGE_SOURCE = "page";

/**
 * The identity of an ordinary page for Sync with its video: a short fingerprint of its origin, path
 * and query (never the fragment), so the address itself is not kept. Two addresses that differ only
 * there (YouTube's `?v=`, another Loom share) never match. Null for anything but http(s).
 */
export function pageKeyOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `p-${fingerprint(`${parsed.origin}${parsed.pathname}${parsed.search}`)}`;
}

// cyrb53 (public domain): a 53-bit string hash, as 14 hex digits. Not cryptographic; it only tells
// two addresses apart without storing them.
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export const isPageKey = (value: unknown): value is string => typeof value === "string" && /^p-[0-9a-f]{14}$/.test(value);

/**
 * The identity of one video on an ordinary page: a random key the content script gives to one
 * <video> element showing one media source, for as long as that document lives. Another element,
 * another source in the same element (`emptied`, `loadstart`) or a reload gives another key, so a
 * result made with one video is never taken for another one at the same address.
 */
export const isVideoKey = (value: unknown): value is string => typeof value === "string" && /^v-[0-9a-f]{16}$/.test(value);

export interface LessonInfo {
  /** Stable key for one lecture: "<course slug>/<lecture id>". */
  key: string;
  courseSlug: string;
  lectureId: string;
  /** Tab title at the time of reading (display only). */
  title: string;
}

const LECTURE_PATH = /^\/course\/([A-Za-z0-9_-]{1,200})\/learn\/lecture\/(\d{1,20})\/?$/;

/** Returns the lecture identity, or null when the URL is not a Udemy lecture page. */
export function parseLecture(url: string, title = ""): LessonInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== UDEMY_ORIGIN) return null;
  const match = LECTURE_PATH.exec(parsed.pathname);
  if (!match) return null;
  const [, courseSlug, lectureId] = match as unknown as [string, string, string];
  return { key: `${courseSlug}/${lectureId}`, courseSlug, lectureId, title: title.slice(0, 300) };
}
