/**
 * Types for the dependency-free cookie jar parser.
 *
 * The module itself is plain ESM so it can be shipped and run by Node exactly as
 * reviewed, with no build step between the source and what an installer runs.
 * This declaration exists so the repository's own type check can import it: a
 * `.mjs` without one is implicitly `any`, which would let a caller pass a
 * `Buffer` or a number and only discover it at run time.
 *
 * Kept beside the module, with the same name, so TypeScript pairs them
 * automatically and the two cannot drift apart unnoticed.
 *
 * @module lib/cookie-jar
 */

/** The prefix `curl` writes on an `HttpOnly` cookie line; a domain marker, not a comment. */
export declare const HTTP_ONLY_PREFIX: "#HttpOnly_";

/**
 * Extract the DSH session cookie from one of the accepted text shapes.
 * @param text - the file or stdin contents.
 * @returns the `Cookie` header value, or an empty string when none was found.
 */
export declare function parseCookieText(text: string | undefined | null): string;

/**
 * Whether a parsed credential looks like a DSH session cookie.
 * @param value - the parsed cookie header value.
 * @returns true when there is a session cookie to send.
 */
export declare function looksLikeSessionCookie(value: unknown): boolean;
