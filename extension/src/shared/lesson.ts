// Identity of a Udemy lecture page, derived only from the URL path.

export const UDEMY_ORIGIN = "https://www.udemy.com";

/**
 * The source key of a tab that shows no Udemy lecture (Loom, any ordinary web page, a Udemy page
 * that is not a lecture): its transcript is pasted or selected by hand and its audio plays on its
 * own, with no video of the page. A lecture key is always "<slug>/<id>", so this can never equal one.
 */
export const PAGE_SOURCE = "page";

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
