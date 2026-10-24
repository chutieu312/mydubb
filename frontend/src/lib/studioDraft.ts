// The unsent Studio form, kept only in page memory (a JavaScript variable). Nothing here is
// written to localStorage, sessionStorage, cookies or the URL, so a reload loses it by design.

export interface StudioDraft {
  transcript: string;
  firstStart: string;
  lastStart: string;
  voice: string;
  speed: number;
}

export interface DraftKeeper {
  /** Remember the draft of the signed-in user. */
  remember: (userId: string, draft: StudioDraft) => void;
  /** The remembered draft, only if it belongs to this user. */
  draftFor: (userId: string) => StudioDraft | undefined;
  /** A user signed in: a draft left by anyone else is dropped, never shown. */
  reconcile: (userId: string) => void;
  /** Explicit sign out. */
  clear: () => void;
}

export function createDraftKeeper(): DraftKeeper {
  let held: { userId: string; draft: StudioDraft } | null = null;
  return {
    remember: (userId, draft) => {
      held = { userId, draft };
    },
    draftFor: (userId) => (held?.userId === userId ? held.draft : undefined),
    reconcile: (userId) => {
      if (held && held.userId !== userId) held = null;
    },
    clear: () => {
      held = null;
    },
  };
}
