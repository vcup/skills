/**
 * The official DSH client transport, wrapped for a Node process.
 *
 * This module exists so the CLI talks to a **running** Host the way a browser
 * does, instead of reaching into the Host's own machinery. It imports the
 * published client entry and nothing from the Host side:
 *
 * - no `dsh-api-gateway`, so it cannot construct a gateway or invoke a service
 *   in-process;
 * - no `Peer`, so it cannot build a principal;
 * - no `principal` at all, so the only identity on the wire is the cookie the
 *   Host issued.
 *
 * That constraint is the point. A client that could assemble its own invocation
 * would prove nothing about the transport, and would let an operator bypass the
 * Host's authentication entirely.
 *
 * The cookie is supplied by the caller and only ever placed in a `Cookie`
 * header. It is never logged, never echoed, and never accepted from the command
 * line, so it cannot leak through shell history or a process listing.
 *
 * @module lib/transport
 */

import { Context } from "@deepseek-ai/cordis";
import { installConnection } from "@deepseek-ai/dsh-client-connection/client";

/** The logical RPC channel the Typert gateway serves Remote methods on. */
export const API_CHANNEL = "/api";

/**
 * Why a call did not produce a business answer.
 *
 * Kept separate from "the Host refused the operation", because the remedies
 * differ: a transport failure is "is the Host running on that port", while a
 * refusal is the answer to a well-formed request.
 */
export class TransportFailure extends Error {
  /** @type {number} Process exit code this failure maps to. */
  exitCode;
  /**
   * @param {string} message
   * @param {number} exitCode
   */
  constructor(message, exitCode) {
    super(message);
    this.name = "TransportFailure";
    this.exitCode = exitCode;
  }
}

/**
 * Normalise a host origin without accepting anything surprising.
 *
 * The target is an explicit origin the operator named. Only `http` and `https`
 * are allowed; credentials embedded in the URL are refused, because that would
 * be a second identity channel the Host never issued; and a path is refused
 * because this client resolves its own routes against the origin.
 * @param {string} value - the `--url` value.
 * @returns {{ origin: string, hostname: string }} the parsed origin and hostname.
 */
export function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TransportFailure(`--url is not a valid absolute URL: ${JSON.stringify(value)}`, 2);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TransportFailure(
      `--url must use http: or https:, not ${url.protocol}: this client never substitutes another transport`,
      2,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new TransportFailure(
      "--url must not embed credentials: pass the session cookie with --cookie-file, --cookie-stdin or ENSEMBLE_ARCHIVE_COOKIE",
      2,
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new TransportFailure(`--url must be an origin, not a path: ${JSON.stringify(value)}`, 2);
  }
  return { origin: url.origin, hostname: url.hostname };
}

/**
 * Open a connection to a running Host.
 *
 * The `fetch` installed here is the whole transport contract:
 *
 * - it sends the cookie the caller supplied and nothing else that could name a
 *   principal;
 * - it forces `redirect: "error"`, so a redirect cannot carry the cookie to an
 *   authority the operator did not name;
 * - it sends `Origin`, because the Host fences `/api` on it, exactly as a
 *   browser would.
 * @param {{ url: string, cookie: string }} options - origin and cookie.
 * @returns {Promise<{ call: Function, close: Function }>} the connection.
 */
export async function connect(options) {
  const { origin, hostname } = parseOrigin(options.url);
  const cookie = options.cookie.trim();
  if (cookie === "") {
    throw new TransportFailure("the credential is empty; nothing was sent", 3);
  }

  const ctx = new Context();
  installConnection(ctx, {
    // A non-browser composition: no document base exists, so the transport is
    // told where the Host lives, and `location` classifies loopback authority
    // the way a page would.
    location: { hostname },
    transport: {
      fetch: (input, init) => {
        const target = typeof input === "string" ? new URL(input, `${origin}/`) : input;
        return fetch(target, {
          ...init,
          redirect: "error",
          headers: {
            ...((init && init.headers) ?? {}),
            cookie,
            origin,
          },
        });
      },
    },
  });

  const connection = ctx.connection;
  if (connection === undefined) {
    throw new TransportFailure("the client transport did not install a connection service", 5);
  }
  // The loop belongs to whoever consumes generations; this CLI reads one answer
  // and exits, so a loop nobody owns would only hold the process open. The
  // callbacks are no-ops because this client has no generation-dependent state
  // to refresh.
  try {
    connection.start({ onReady: () => {}, onLost: () => {} });
  } catch {
    // A carrier without a generation source cannot start a loop; the unary RPC
    // path does not need one, so this is not fatal here.
  }

  return {
    async call(endpoint, payload) {
      const parts = endpoint.split("/");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        throw new TransportFailure(`endpoint must be namespace/method, got ${JSON.stringify(endpoint)}`, 2);
      }
      let result;
      try {
        // The gateway's wire payload is exactly one plain-object `args` field.
        // It is not the Remote's own `request` object: that goes inside `args`,
        // which is why the CLI wraps it rather than sending it directly.
        result = await connection.rpc.call(API_CHANNEL, endpoint, { args: payload });
      } catch (error) {
        // A refusal the Host sent is still a reached Host; only a transport-level
        // failure means it was never reached. The distinction decides whether the
        // operator should start the Host or fix the request.
        const message = (error && error.message) || String(error);
        // A 401 is the Host refusing the *credential*, which is a different
        // remedy from a refused operation: the operator must authenticate, not
        // correct the request. It therefore gets its own exit code.
        if (/HTTP 401|unauthorized|unauthenticated/i.test(message)) {
          throw new TransportFailure(
            `the Host rejected this credential at ${origin}: ${message}\n  Authenticate again and retry with a fresh cookie.`,
            4,
          );
        }
        if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|network/i.test(message)) {
          throw new TransportFailure(
            `could not reach the Host at ${origin}: ${message}\n  Is the Host running, and is --url the origin it printed?`,
            5,
          );
        }
        throw new TransportFailure(`the Host rejected the call at ${origin}: ${message}`, 1);
      }
      return unwrapResult(result);
    },
    async close() {
      // Teardown is best effort: the answer has already been printed, and a
      // process exiting with the right code matters more than a tidy scope.
      // `dispose` exists on a Cordis Context but is not guaranteed on every
      // runtime that installs the service, so it is called only if present.
      if (typeof ctx.dispose === "function") {
        try {
          await ctx.dispose();
        } catch {
          /* nothing left to report; the exit code already carries the outcome */
        }
      }
    },
  };
}

/**
 * Turn one decoded RPC result into the Remote's own answer.
 *
 * The Connection returns a result envelope; the Remote's answer is inside it.
 * A rejected credential has its own exit code because its remedy differs from a
 * business refusal.
 * @param {unknown} result - the value `rpc.call` resolved with.
 * @returns {unknown} the Remote's result value.
 */
export function unwrapResult(result) {
  if (result !== null && typeof result === "object") {
    if (result.ok === true) return result.value;
    if (result.ok === false) {
      const error = result.error;
      const code = error && typeof error.code === "string" ? error.code : "unknown";
      const message = error && typeof error.message === "string" ? error.message : "the Host returned an error";
      if (code === "unauthenticated" || code === "unauthorized") {
        throw new TransportFailure(`the Host rejected this credential: ${message}`, 4);
      }
      throw new TransportFailure(`the Host refused the call (${code}): ${message}`, 1);
    }
  }
  throw new TransportFailure("the Host returned a response this client does not understand", 5);
}
