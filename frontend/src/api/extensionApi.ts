import { ApiError, request } from "./client";

// The website half of connecting the Chrome extension (docs/EXTENSION_AUTH.md). The signed-in
// user approves; the server answers with the extension's redirect URI carrying a one-time code.

export interface ExtensionAuthorization {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: "S256";
}

const CLIENT_ID = /^[a-p]{32}$/;
const STATE = /^[A-Za-z0-9._~-]{16,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** The only redirect URI an extension can have: Chrome's per-extension launchWebAuthFlow host. */
export function extensionRedirectUri(clientId: string): string {
  return `https://${clientId}.chromiumapp.org/`;
}

/**
 * The request the extension opened this page with, or null when it is not one. The server checks
 * it again (allowed extension IDs, exact redirect URI); this only refuses obvious junk early.
 */
export function parseAuthorization(search: string): ExtensionAuthorization | null {
  const params = new URLSearchParams(search);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  if (!CLIENT_ID.test(clientId) || redirectUri !== extensionRedirectUri(clientId)) return null;
  if (!STATE.test(state) || !CHALLENGE.test(challenge)) return null;
  if (params.get("code_challenge_method") !== "S256") return null;
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
}

export const extensionApi = {
  /** Approve the extension; resolves to where the page must go next (the extension's URI). */
  authorize: async (authorization: ExtensionAuthorization): Promise<string> => {
    const payload = await request<unknown>("POST", "/api/extension/authorize", {
      body: authorization,
      accept: [200],
    });
    const url = (payload as { redirect_url?: unknown } | null)?.redirect_url;
    // Never navigate anywhere but the redirect URI the request named.
    if (typeof url !== "string" || !url.startsWith(`${authorization.redirect_uri}?`)) {
      throw new ApiError(502, "unexpected_response", "The server sent an unexpected response.");
    }
    return url;
  },
};
