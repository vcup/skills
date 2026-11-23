#!/usr/bin/env node
/**
 * `ensemble-archive` — call the owner archive Remote on a running DSH Host.
 *
 * The owner archive surface is a Remote: it is reachable only from an
 * authenticated owner Peer, which meant that until now an operator who installed
 * the package had no way to use it without writing a client. This bin is that
 * client, and it stays honest about what it is:
 *
 * - it talks to a **running** Host over the official client transport, so the
 *   Peer and its `owner` principal are assigned by the Host's connection layer
 *   from the session cookie. This process never constructs a Peer, never sets a
 *   principal, and cannot: it imports no gateway and no peer module.
 * - with no credential it sends **nothing** and exits 3. It never falls back to
 *   an in-process call or a synthetic identity, because a tool that quietly
 *   elevates itself is worse than one that refuses.
 * - the credential arrives from a file, stdin or the environment — never from
 *   argv, so it does not reach shell history or a process listing — and it is
 *   never echoed.
 *
 * Exit codes are the contract (see the package README):
 *   0 success
 *   1 the Host refused the operation (invalid input, unsafe path, conflict)
 *   2 usage error, including a credential passed on the command line
 *   3 no credential, or an empty one; nothing was sent
 *   4 the Host rejected the credential
 *   5 the Host could not be reached
 *
 * @module bin/ensemble-archive
 */

import { readFileSync } from "node:fs";
import process from "node:process";

import { looksLikeSessionCookie, parseCookieText } from "../lib/cookie-jar.mjs";
// The generated bundle, not the reviewed source: `lib/transport.mjs` imports
// `@deepseek-ai/cordis` and the client entry as bare specifiers, and a Node
// process started from an installed package has no DSH profile to resolve them
// from. The bundle is that same source with its four-package closure inlined, so
// this file imports nothing but its own relative files and Node builtins.
import { connect, TransportFailure } from "../lib/transport.bundle.mjs";

/** Namespace the plugin registers its owner Remote under. */
const NAMESPACE = "ensembleArchive";

/**
 * Methods the Remote exposes, and whether they take a request body.
 *
 * `retired: true` entries stay listed so an old script gets a precise refusal,
 * but they are refused by this client **before any connection is opened**: a
 * retired entry must not reach a Host and create a v1 archive.
 */
const METHODS = {
  projects: { requestRequired: false },
  query: { requestRequired: true },
  manage: { requestRequired: true },
  choose: { requestRequired: true },
  approve: { requestRequired: true },
  environment: { requestRequired: true },
  watch: { requestRequired: true },
  status: { requestRequired: false, retired: true },
  initialize: { requestRequired: true, retired: true },
  bind: { requestRequired: true, retired: true },
  readBack: { requestRequired: true, retired: true },
};

/** Supported methods, for help and error text. */
const SUPPORTED = Object.keys(METHODS).filter((name) => !METHODS[name].retired);
/** Retired methods, for help and error text. */
const RETIRED = Object.keys(METHODS).filter((name) => METHODS[name].retired);

/** Default Host origin: the web profile's default port on loopback. */
const DEFAULT_URL = "http://127.0.0.1:3731";

/** Environment variable that may carry the session cookie. */
const COOKIE_ENV = "ENSEMBLE_ARCHIVE_COOKIE";

const USAGE = `ensemble-archive — call the owner archive Remote on a running DSH Host

Usage:
  ensemble-archive <${SUPPORTED.join("|")}> [options]

Create and change an archive with \`manage\`:
  manage --request '{"action":"initialize","expected_revision":"absent","operation_id":"…","payload":{…}}'
  manage --request '{"action":"bind","project_id":"…","expected_revision":"<40-hex>","operation_id":"…","payload":{…}}'
Read state with \`projects\`, \`query\` or \`environment\`.

Retired in the 1.0 package: ${RETIRED.join(", ")}.
They are refused without contacting the Host. Creation moved to \`manage\`;
reads moved to \`projects\`/\`query\`. A 0.3.0 archive is migrated only by an
explicit owner flow: plan a \`legacy_upgrade\` through \`manage\`, then commit it.
The old repository, its head and its history are never written by this package.

Options:
  --url <origin>        Host origin (default ${DEFAULT_URL})
  --request <json|@f>   the endpoint's request object, inline JSON or @file
  --cookie-file <path>  read the session cookie from a file
  --cookie-stdin        read the session cookie from stdin
  --json                print the raw result envelope
  -h, --help            this help

Credential (exactly one of):
  --cookie-file <path>  a curl cookie jar, a Cookie: header line, or name=value
  --cookie-stdin        the same text on stdin
  ${COOKIE_ENV}  the same text in the environment

The credential is never accepted as a command-line argument, so it cannot be
captured from shell history or a process listing, and it is never echoed.

Exit codes:
  0 success    1 Host refused    2 usage    3 no credential    4 credential rejected    5 unreachable
`;

/** A usage error: wrong invocation, nothing was sent. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Parse argv into a method and options.
 *
 * A credential supplied as `--cookie <value>` is rejected deliberately rather
 * than silently accepted: accepting it would defeat the reason credentials are
 * restricted to files, stdin and the environment.
 * @param {string[]} argv - process arguments after the executable and script.
 * @returns {{ method: string, options: object }} the parsed invocation.
 */
function parseArgv(argv) {
  const options = { url: DEFAULT_URL, request: undefined, cookieFile: undefined, cookieStdin: false, json: false };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${name} needs a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "-h" || arg === "--help") return { method: "help", options };
    else if (arg === "--url") options.url = takeValue("--url");
    else if (arg === "--request") options.request = takeValue("--request");
    else if (arg === "--cookie-file") options.cookieFile = takeValue("--cookie-file");
    else if (arg === "--cookie-stdin") options.cookieStdin = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--cookie" || arg.startsWith("--cookie=")) {
      throw new UsageError(
        "refusing a credential on the command line: it would be visible in shell history and in a process listing.\n" +
          "  Use --cookie-file <path>, --cookie-stdin, or the ENSEMBLE_ARCHIVE_COOKIE environment variable.",
      );
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }

  if (positional.length === 0) throw new UsageError("a method is required");
  if (positional.length > 1) throw new UsageError(`unexpected argument ${JSON.stringify(positional[1])}`);
  const method = positional[0];
  if (method === undefined || !Object.hasOwn(METHODS, method)) {
    throw new UsageError(
      `unknown method ${JSON.stringify(method)}; expected one of ${Object.keys(METHODS).join(", ")}`,
    );
  }
  return { method, options };
}

/**
 * Read the request payload.
 * @param {object} options - parsed options.
 * @param {string} method - the chosen method.
 * @returns {object} the request object to send (possibly empty).
 */
function readRequest(options, method) {
  if (options.request === undefined) {
    if (METHODS[method].requestRequired) {
      throw new UsageError(`${method} needs --request <json|@file>`);
    }
    return {};
  }

  const raw = options.request.startsWith("@")
    ? readFileSync(options.request.slice(1), "utf8")
    : options.request;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`--request is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--request must be a JSON object");
  }
  return parsed;
}

/**
 * Resolve the session cookie from the one allowed source.
 *
 * Reading from the environment, stdin or a file — never argv — is what keeps the
 * value out of shell history and process listings.
 * @param {object} options - parsed options.
 * @returns {string} the Cookie header value, or an empty string when absent.
 */
function readCredential(options) {
  const fromStdin = options.cookieStdin;
  const fromFile = options.cookieFile;
  const fromEnv = process.env[COOKIE_ENV];

  const chosen = [fromFile !== undefined, fromStdin, fromEnv !== undefined && fromEnv !== ""].filter(Boolean);
  if (chosen.length > 1) {
    throw new UsageError(
      `more than one credential source was given; pass exactly one of --cookie-file, --cookie-stdin or ${COOKIE_ENV}`,
    );
  }

  let text;
  if (fromFile !== undefined) {
    try {
      text = readFileSync(fromFile, "utf8");
    } catch (error) {
      // A missing file is a usage problem, not an empty credential: the operator
      // named something that is not there.
      throw new UsageError(`could not read --cookie-file ${fromFile}: ${error.message}`);
    }
  } else if (fromStdin) {
    text = readFileSync(0, "utf8");
  } else if (fromEnv !== undefined) {
    text = fromEnv;
  } else {
    return "";
  }

  const cookie = parseCookieText(text);
  return looksLikeSessionCookie(cookie) ? cookie : "";
}

/**
 * The message shown for a retired method.
 *
 * Exit code 2 (usage), not 1 (Host refused), on purpose: nothing was sent, so a
 * script branching on the exit code learns this client did not even try, and the
 * text names the replacement.
 * @param method - the retired method that was requested.
 * @returns the operator-facing explanation.
 */
function retiredMessage(method) {
  const replacement =
    method === "initialize" || method === "bind"
      ? 'Create or rebind an archive with `manage`: {"action":"initialize",…} or {"action":"bind",…}.'
      : 'Read archive state with `projects` or `query` (kinds `context`, `object`, `artifact`).';
  return [
    `ensemble-archive: ${method} is retired in the 1.0 package; nothing was sent.`,
    "",
    `  ${replacement}`,
    "",
    "  A 0.3.0 archive is migrated only by an explicit owner flow:",
    '    manage {"action":"plan_maintenance","payload":{"kind":"legacy_upgrade","source_handle":"…","target_format":"ensemble-archive/v2","reason":"…"}}',
    '    manage {"action":"upgrade","payload":{…}}   # after review, backup and stopping the old writer',
    "  The old repository, its head and its history are never written by this package.",
  ].join("\n");
}

/** The message shown when there is no credential at all. */
function noCredentialMessage() {
  return [
    "no credential: this client needs an authenticated DSH web session.",
    "",
    "  Start the Host, then authenticate once and save the cookie:",
    "    dsh --profile web             # prints a local URL carrying a launch token",
    '    curl -c jar.txt "<that URL>"  # exchanges the token for a session cookie',
    `  Then pass --cookie-file jar.txt, use --cookie-stdin, or set ${COOKIE_ENV}.`,
    "",
    "  Nothing was sent: this client never falls back to a local or synthetic identity.",
  ].join("\n");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`ensemble-archive: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (parsed.method === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const { method, options } = parsed;

  let request;
  let cookie;
  try {
    request = readRequest(options, method);
    cookie = readCredential(options);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`ensemble-archive: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (cookie === "") {
    process.stderr.write(`ensemble-archive: ${noCredentialMessage()}\n`);
    return 3;
  }

  // A retired entry is refused here, before a connection exists: reaching a Host
  // with an old payload shape is exactly what 1.0 must not do. Exit 2 (usage)
  // rather than 1, because nothing was sent.
  if (METHODS[method].retired) {
    process.stderr.write(`${retiredMessage(method)}\n`);
    return 2;
  }

  let connection;
  try {
    connection = await connect({ url: options.url, cookie });
    // The Remote's answer is printed verbatim rather than reshaped, so this
    // client cannot disagree with the Host about what happened.
    const value = await connection.call(`${NAMESPACE}/${method}`, { request });
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    // A refusal the Host returned is a refused operation, not a success: the
    // exit code is what a script branches on, so `ok: false` must not exit 0.
    if (value !== null && typeof value === "object" && value.ok === false) {
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof TransportFailure) {
      process.stderr.write(`ensemble-archive: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`ensemble-archive: ${(error && error.message) || String(error)}\n`);
    return 5;
  } finally {
    // The connection's loop holds sockets; a CLI that returned must not linger.
    await connection?.close?.();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`ensemble-archive: ${(error && error.stack) || String(error)}\n`);
    process.exit(5);
  },
);
