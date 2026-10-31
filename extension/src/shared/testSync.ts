// Test helper: the sync part of a session view when Sync is unavailable (no source span).

import type { SyncView } from "./sync";

export const NO_SYNC: SyncView = {
  status: "unavailable",
  unavailable: "no-metadata",
  start: null,
  end: null,
  duration: null,
  rate: null,
  confirmed: false,
  notice: null,
};
