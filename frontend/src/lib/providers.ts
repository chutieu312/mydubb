import type { AppMeta } from "../api/types";

/** True when submitting a transcript sends its text to Azure. */
export function sendsTranscriptToAzure(providers: AppMeta["providers"]): boolean {
  return providers.translation === "azure";
}
