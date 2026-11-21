/**
 * Cookie parsing only — no HTTP, no transport.
 *
 * A browser hands its cookie jar to `fetch` automatically; a Node CLI has to
 * read one. This module does the smallest thing that covers the ways an
 * operator ends up with a session cookie:
 *
 * - a Netscape `cookies.txt` jar, which is what `curl -c` writes;
 * - a `Cookie:` header line copied from a browser's network panel;
 * - a bare `name=value` line.
 *
 * It deliberately does not validate or decode the value. The Host decides
 * whether a cookie is acceptable; a client that pre-judged it could disagree
 * with the Host and report a different reason for the same 401.
 *
 * @module lib/cookie-jar
 */

/**
 * Extract the DSH session cookie from one of the accepted text shapes.
 *
 * Netscape jars and header lines can carry several cookies; the Host's session
 * cookie is the one whose name starts with `dsh-auth-`, so that is what is
 * selected when present. A bare `name=value` line is taken as-is.
 * @param {string} text - the file or stdin contents.
 * @returns {string} the `Cookie` header value, or an empty string when none was found.
 */
export function parseCookieText(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return "";

  // Netscape jar lines are tab-separated with the domain in column 1 and the
  // name/value in the last two; comments start with '#'. A browser's header
  // line or a bare name=value pair has no tabs, so this branch is unambiguous.
  const jarLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => line.includes("\t"));

  if (jarLines.length > 0) {
    const pairs = jarLines
      .map((line) => {
        const columns = line.split("\t");
        return {
          name: (columns[columns.length - 2] ?? "").trim(),
          value: (columns[columns.length - 1] ?? "").trim(),
        };
      })
      .filter((pair) => pair.name !== "" && pair.value !== "");
    const session = pairs.filter((pair) => pair.name.startsWith("dsh-auth-"));
    const chosen = session.length > 0 ? session : pairs;
    if (chosen.length > 0) return chosen.map((pair) => `${pair.name}=${pair.value}`).join("; ");
    return "";
  }

  // A `Cookie:` header line, or a bare name=value pair.
  return trimmed.replace(/^cookie:\s*/i, "").split(/\r?\n/)[0].trim();
}

/**
 * Whether a parsed credential looks like a DSH session cookie.
 *
 * Only a shape check: an empty or unrelated value is caught here so the caller
 * can report "no credential" instead of sending an empty header and surfacing a
 * 401 the operator cannot act on.
 * @param {string} value - the parsed cookie header value.
 * @returns {boolean} true when there is a session cookie to send.
 */
export function looksLikeSessionCookie(value) {
  return typeof value === "string" && /(^|;\s*)dsh-auth-[^=\s]+=\S/.test(value);
}
