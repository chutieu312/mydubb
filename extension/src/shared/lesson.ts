// Identity of a Udemy lecture page, derived only from the URL path.

export const UDEMY_ORIGIN = "https://www.udemy.com";

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
