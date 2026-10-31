// Connecting the extension to a MyDubb invitation account: OAuth 2.0 Authorization Code + PKCE
// (S256) against MyDubb's own /extension/connect page, opened in Chrome's sign-in window
// (chrome.identity.launchWebAuthFlow). The password is typed on mydubb.com, never here. The
// resulting bearer token is kept only in chrome.storage.session (memory, trusted contexts: never
// readable by content scripts or Udemy pages) and is cleared when the browser closes.
// Contract: docs/EXTENSION_AUTH.md.

import { MyDubbError, type ExtensionUser, type MyDubbApi } from "./api";

export const AUTH_KEY = "auth";

export interface StoredAuth {
  token: string;
  user: ExtensionUser;
  expiresAt: string;
  // A new value at every connection: tells two connections of the same user apart.
  connectionId: string;
}

export function isStoredAuth(value: unknown): value is StoredAuth {
  const v = value as Partial<StoredAuth> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.token === "string" &&
    v.token !== "" &&
    typeof v.expiresAt === "string" &&
    typeof v.connectionId === "string" &&
    typeof v.user === "object" &&
    v.user !== null &&
    typeof v.user.id === "string" &&
    typeof v.user.email === "string"
  );
}

/** A stored token that has not reached its expiry (the server decides; this avoids a request). */
export function isLive(auth: StoredAuth, now: number): boolean {
  const expires = Date.parse(auth.expiresAt);
  return Number.isFinite(expires) && expires > now;
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

/** A fresh verifier (43 characters from 32 random bytes), its S256 challenge, and a state. */
export async function createPkce(random: (n: number) => Uint8Array = randomBytes): Promise<Pkce> {
  const verifier = base64url(random(32));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest), state: base64url(random(24)) };
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function redirectUriFor(extensionId: string): string {
  return `https://${extensionId}.chromiumapp.org/`;
}

export function authorizeUrl(origin: string, extensionId: string, pkce: Pkce): string {
  const params = new URLSearchParams({
    client_id: extensionId,
    redirect_uri: redirectUriFor(extensionId),
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  return `${origin}/extension/connect?${params.toString()}`;
}

export type ConnectFailure = "cancelled" | "state-mismatch" | "bad-redirect" | "refused";

export class ConnectError extends Error {
  constructor(
    readonly reason: ConnectFailure,
    message: string,
  ) {
    super(message);
  }
}

/** The code from the redirect Chrome captured, after checking where it came back and its state. */
export function codeFromRedirect(redirect: string, extensionId: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    throw new ConnectError("bad-redirect", "MyDubb sent the sign-in back to an unexpected address.");
  }
  if (`${url.origin}${url.pathname}` !== redirectUriFor(extensionId)) {
    throw new ConnectError("bad-redirect", "MyDubb sent the sign-in back to an unexpected address.");
  }
  if (url.searchParams.get("state") !== expectedState) {
    throw new ConnectError("state-mismatch", "The sign-in answer did not match this request, so it was ignored.");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new ConnectError("refused", "MyDubb did not connect the extension.");
  return code;
}

export interface ConnectDeps {
  origin: string;
  extensionId: string;
  api: Pick<MyDubbApi, "exchangeCode">;
  /** chrome.identity.launchWebAuthFlow (interactive); resolves to the captured redirect URL. */
  launchWebAuthFlow(url: string): Promise<string | undefined>;
  newConnectionId(): string;
  pkce?: () => Promise<Pkce>;
}

/** Runs the sign-in window and the code exchange. Resolves to what must be stored. */
export async function connect(deps: ConnectDeps): Promise<StoredAuth> {
  const pkce = await (deps.pkce ?? createPkce)();
  let redirect: string | undefined;
  try {
    redirect = await deps.launchWebAuthFlow(authorizeUrl(deps.origin, deps.extensionId, pkce));
  } catch {
    // The user closed the window or cancelled; Chrome gives no further detail.
    throw new ConnectError("cancelled", "The MyDubb sign-in window was closed before connecting.");
  }
  if (!redirect) throw new ConnectError("cancelled", "The MyDubb sign-in window was closed before connecting.");
  const code = codeFromRedirect(redirect, deps.extensionId, pkce.state);
  const grant = await deps.api.exchangeCode({
    client_id: deps.extensionId,
    redirect_uri: redirectUriFor(deps.extensionId),
    code,
    code_verifier: pkce.verifier,
  });
  return {
    token: grant.access_token,
    user: grant.user,
    expiresAt: grant.expires_at,
    connectionId: deps.newConnectionId(),
  };
}

export function connectErrorMessage(error: unknown): string {
  if (error instanceof ConnectError) return error.message;
  if (error instanceof MyDubbError) {
    if (error.code === "invalid_grant" || error.code === "extension_unknown" || error.code === "extension_disabled") {
      return error.message;
    }
    if (error.status === 0) return `${error.message} The extension was not connected.`;
    return "MyDubb could not connect the extension. Please try again.";
  }
  return "MyDubb could not connect the extension. Please try again.";
}
