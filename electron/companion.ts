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

/**
 * Where the token travels. A header, never the URL — SPT logs every request path, so a token in
 * the URL would end up written to disk on the very machine it protects.
 */
export const COMPANION_TOKEN_HEADER = "x-sptarky-token";

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

/* ---------------------------------------------------------------------------------------- *
 * The manifest — what the server actually has installed.
 * ---------------------------------------------------------------------------------------- */

/** A mod on the server, after its declared version has been reconciled against the ledger. */
export interface RemoteMod {
  /** Folder name — the identity the manager matches on, the same as it uses locally. */
  id: string;
  type: "server" | "client";
  /** The version to believe. See `versionSource` for where it came from. */
  version?: string;
  /** What the mod says about itself. Kept even when overridden, so a disagreement can be shown. */
  declaredVersion?: string;
  /**
   * `ledger` means that machine's manager recorded the install, which beats the mod's own
   * claim; `declared` means the mod's word is all there is. Never inferred from the version
   * string itself.
   */
  versionSource: "ledger" | "declared" | "unknown";
  guid?: string;
  name?: string;
  /** False for anything in mods.disabled / plugins.disabled — present but not running. */
  enabled: boolean;
  /**
   * Present on disk but not in SPT's loaded list: it failed validation or threw on load.
   * Server mods only; the server cannot tell whether a client plugin loaded.
   */
  failedToLoad?: boolean;
}

export interface RemoteManifest {
  serverMods: RemoteMod[];
  clientMods: RemoteMod[];
  /** Addon ledger entries, verbatim, for parity checks the manager already knows how to do. */
  addons: unknown[];
  /**
   * False when that machine has no BepInEx beside the server. Its client list is then EMPTY
   * BECAUSE UNKNOWN, and no parity check may treat it as "the server has no client mods".
   */
  clientKnown: boolean;
  /** True when no ledger was found, so every version is only what the mods claim. */
  versionsAreDeclaredOnly: boolean;
  warnings: string[];
}

/**
 * Turns the companion's answer into something the app can compare against a local install.
 *
 * The reconciling happens HERE rather than on the server, which is why the companion ships the
 * ledger verbatim. The rule it applies is the one that motivated the whole companion: a version
 * the remote manager RECORDED at install time beats the version the mod declares about itself,
 * because authors forget to bump manifests and the ledger cannot.
 *
 * Returns null only when the payload is not a manifest at all. Everything softer — a missing
 * ledger, an unreadable BepInEx, a truncated list — comes back as a manifest that says so,
 * because refusing the whole thing over one absent field would throw away the parts that were
 * fine.
 */
export function readManifest(body: unknown): RemoteManifest | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.serverMods) || !Array.isArray(raw.clientMods)) return null;

  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(String) : [];

  // The ledger is the remote machine's registry file as text. A corrupt one is not fatal: fall
  // back to declared versions and SAY so, rather than losing the mod list along with it.
  let ledger: Record<string, { installedVersion?: string }> = {};
  let ledgerParsed = false;
  if (typeof raw.registryJson === "string" && raw.registryJson.trim()) {
    try {
      const entries = JSON.parse(raw.registryJson);
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e && typeof e.id === "string") ledger[e.id] = e;
        }
        ledgerParsed = true;
      }
    } catch {
      warnings.push("The server's version ledger could not be read, so only declared versions are available.");
    }
  }

  let addons: unknown[] = [];
  if (typeof raw.addonsJson === "string" && raw.addonsJson.trim()) {
    try {
      const parsed = JSON.parse(raw.addonsJson);
      if (Array.isArray(parsed)) addons = parsed;
    } catch {
      warnings.push("The server's addon ledger could not be read.");
    }
  }

  const reconcile = (entry: Record<string, unknown>, type: "server" | "client"): RemoteMod => {
    const id = String(entry.folder ?? entry.name ?? "");
    const declared = typeof entry.declaredVersion === "string" ? entry.declaredVersion : undefined;
    // Exact first. The stripped form is only a FALLBACK: checked against the live install, the
    // registry stores a loose client plugin under its full filename ("DrakiaXYZ-BigBrain.dll",
    // 6 of them), so stripping first would miss precisely those.
    const recorded = (ledger[id] ?? ledger[id.replace(/\.dll$/i, "")])?.installedVersion;
    return {
      id,
      type,
      version: recorded ?? declared,
      declaredVersion: declared,
      versionSource: recorded ? "ledger" : declared ? "declared" : "unknown",
      guid: typeof entry.guid === "string" ? entry.guid : undefined,
      name: typeof entry.name === "string" ? entry.name : undefined,
      enabled: entry.enabled !== false,
      ...(entry.loaded === false ? { failedToLoad: true } : {})
    };
  };

  return {
    serverMods: (raw.serverMods as Record<string, unknown>[]).map((m) => reconcile(m, "server")).filter((m) => m.id),
    // The name is kept EXACTLY as it appears on disk, extension and all, because that is the
    // identity the manager's own registry uses for a client plugin.
    clientMods: (raw.clientMods as Record<string, unknown>[]).map((m) => reconcile(m, "client")).filter((m) => m.id),
    addons,
    clientKnown: raw.clientRootFound === true,
    versionsAreDeclaredOnly: !ledgerParsed,
    warnings
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
