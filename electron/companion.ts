/**
 * The SPTarky server companion — detection, and what to do without it (v1.3.5).
 *
 * A plain SPT server cannot answer the three questions this app most wants to ask it. Probed
 * against a live 4.0.13 server rather than assumed:
 *
 *   client mods            every candidate endpoint 404s. SPT has no notion of them; the
 *                          server never sees the client's BepInEx folder.
 *   real installed versions /launcher/server/loadedServerMods reports what each mod's
 *                          package.json DECLARES. Artem reads 3.0.0 while 3.0.1 is what is
 *                          actually installed, because its author never bumped the manifest.
 *                          The truth lives in that machine's version ledger, which no
 *                          endpoint exposes.
 *   mod files              /files/ serves BUNDLES only. There is no route that hands over a
 *                          mod's actual files.
 *
 * So a companion mod supplies them, and this module is the half that decides whether it is
 * there. That decision comes FIRST and everything else is gated behind it, because most
 * servers will never have it: a server without the companion has to keep working exactly as
 * it does today rather than erroring or, worse, reporting emptiness as fact.
 *
 * ## The shape of the contract
 *
 * Read-only by construction. There are no write routes to call, and file serving is rooted at
 * `user/mods` and `BepInEx/plugins` with the path resolved from a mod's IDENTITY rather than
 * from a caller-supplied filename — so there is no path parameter to abuse in the first
 * place. That is deliberate: the restriction is structural, not a setting somebody can widen.
 */

export const COMPANION_ROUTE_PREFIX = "/sptarky";

/** Bumped when the contract changes in a way an older manager could misread. */
export const COMPANION_PROTOCOL = 1;

export interface CompanionCapabilities {
  /** Whether the companion answered at all. Everything else is meaningless without it. */
  present: boolean;
  /** Its own version, for reporting a mismatch rather than failing mysteriously. */
  version?: string;
  /** The contract it speaks. */
  protocol?: number;
  /** Server mods, client mods and addons with ledger-recorded versions. */
  manifest: boolean;
  /** Mod files can be pulled from the server instead of the catalogue. */
  files: boolean;
  /** The companion wants a token and this manager has not supplied a valid one. */
  unauthorised?: boolean;
  /**
   * Why the companion is unusable, when it is reachable but cannot be relied on. Present
   * only alongside `present: false`, and phrased for a person.
   */
  reason?: string;
}

export const NO_COMPANION: CompanionCapabilities = { present: false, manifest: false, files: false };

/**
 * Decides what a server can do, from its answer to `/sptarky/version`.
 *
 * Kept as a pure function so the awkward cases are testable without a server: absent,
 * present, too new, unauthorised, and reachable-but-nonsense. Every one of those must reduce
 * to "carry on as before", because the alternative is an app that breaks against the servers
 * that make up almost all of them.
 */
export function readCapabilities(status: number, body: unknown): CompanionCapabilities {
  // 404 is the expected answer from an ordinary SPT server, and is not a problem to report.
  if (status === 404) return NO_COMPANION;
  if (status === 401 || status === 403) {
    return { ...NO_COMPANION, unauthorised: true, reason: "The server companion needs a token this manager has not been given." };
  }
  if (status !== 200 || !body || typeof body !== "object") {
    return { ...NO_COMPANION, reason: status ? `The server companion answered ${status}.` : "The server could not be reached." };
  }

  const raw = body as Record<string, unknown>;

  // SPT answers a route that IS registered but returned null with HTTP 200 and
  // {"err":404,"errmsg":"UNHANDLED RESPONSE: /url"}. That is a BROKEN companion, not an absent
  // one — an absent route 404s with an empty body and never reaches here. Worth telling apart,
  // because "not installed" and "installed and misbehaving" call for opposite responses from
  // whoever reads the message.
  if (raw.err !== undefined && raw.err !== 0) {
    return { ...NO_COMPANION, reason: "The server companion is installed but its routes are not answering. It may need updating." };
  }

  const protocol = Number(raw.protocol);
  if (!Number.isFinite(protocol)) {
    return { ...NO_COMPANION, reason: "The server companion did not say which contract it speaks." };
  }
  if (protocol > COMPANION_PROTOCOL) {
    // Newer than this manager understands. Refusing beats guessing at fields whose meaning
    // may have changed — and it names the fix rather than failing obscurely later.
    return {
      ...NO_COMPANION,
      version: typeof raw.version === "string" ? raw.version : undefined,
      protocol,
      reason: "The server companion is newer than this manager. Update the manager to use it."
    };
  }

  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : [];
  return {
    present: true,
    version: typeof raw.version === "string" ? raw.version : undefined,
    protocol,
    // Each capability is asked about by name rather than inferred from the version, so a
    // companion can ship one before the other without this having to know release history.
    manifest: capabilities.includes("manifest"),
    files: capabilities.includes("files")
  };
}

/**
 * One line for the UI.
 *
 * "No companion" is stated as a limitation of what can be known, never as a finding about the
 * server's mods. A server without it is not a server with no client mods — it is a server
 * that cannot be asked, and those must not read the same.
 */
export function describeCapabilities(caps: CompanionCapabilities): string {
  if (caps.present) {
    const has = [caps.manifest ? "mods and addons" : null, caps.files ? "mod files" : null].filter(Boolean);
    return has.length
      ? `Server companion ${caps.version ?? ""} connected — ${has.join(", ")}.`.replace("  ", " ")
      : `Server companion ${caps.version ?? ""} connected, but it offers nothing this manager uses.`;
  }
  if (caps.reason) return caps.reason;
  return "This server has no SPTarky companion, so only its server mods and bundles can be seen. Client mods and addons cannot be read from it.";
}
