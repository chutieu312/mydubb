// Types for core.mjs (used from TypeScript in playwright.live.config.ts and live.spec.ts).

export interface LiveUser {
  email: string;
  password: string;
}

export declare function isLoopbackHost(hostname: string): boolean;
export declare function parseLoopbackUrl(value: string, name: string): URL;
export declare function isSameOrigin(url: string, origin: string): boolean;
export declare function redirectAllowed(location: string | undefined, requestOrigin: string): boolean;
export declare function safeDecode(text: string): string;
export declare function resolveStatic(
  dist: string,
  rawPathname: string,
):
  | { kind: "file"; file: string }
  | { kind: "index" }
  | { kind: "bad-request" }
  | { kind: "not-found" };
export declare const LIVE_FIELDS: readonly string[];
export declare function parseLiveEnv(text: string): Record<string, string>;
export declare function liveUsersFrom(values: Record<string, string>): {
  user1: LiveUser;
  user2: LiveUser;
  warnings: string[];
};
export declare function secretForms(users: LiveUser[]): string[];
export declare function scrub(text: string, forms: string[]): string;
