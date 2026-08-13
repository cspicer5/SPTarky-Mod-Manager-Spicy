/**
 * Reads a live SPT 4.x server over its own HTTP API.
 *
 * This is the third instance in the model: a running server somewhere on the network, whose
 * mods you must match before you can play on it. Unlike the main and headless instances it
 * is REMOTE and READ-ONLY — the app reports what differs and never writes to it.
 *
 * Two protocol facts, both discovered the hard way, and both of which make a perfectly
 * healthy server look dead if you get them wrong:
 *
 *   1. SPT 4.x serves HTTPS on 6969 with a SELF-SIGNED certificate (CN=localhost). A plain
 *      HTTP request is accepted and then closed having sent zero bytes — no error, no reset,
 *      nothing to distinguish it from a crashed process.
 *   2. Response bodies are raw zlib, regardless of what Content-Encoding claims. Node will
 *      not inflate them for you.
 *
 * The endpoint that matters is /launcher/server/loadedServerMods, which the official SPT
 * launcher already reads, needs no authentication, and returns each mod's GUID, name,
 * author, version, SPT version constraint, dependencies and often a source URL.
 *
 * NOT used, deliberately: /launcher/server/serverModsUsedByProfile. That is what the
 * launcher labels "Inactive Server Mods", and its own subtitle explains why it is no use
 * here — "these mods have not been loaded by the server, but your profile has used them in
 * the past". Every entry is an older version of a mod that is already active, so it answers
 * "what has this profile seen before", not "what do I need in order to play".
 */
import https from "https";
import http from "http";
import zlib from "zlib";
import { ModInfo } from "./types";
import { compareVersions } from "./modManager";
import {
  readCapabilities,
  readManifest,
  NO_COMPANION,
  COMPANION_TOKEN_HEADER,
  type CompanionCapabilities,
  type RemoteMod
} from "./companion";

export interface SptServerMod {
  modGuid?: string;
  name: string;
  author?: string;
  /** What is really installed. Corrected from the companion's ledger when there is one. */
  version?: string;
  /** Only set when the ledger overrode it — i.e. the mod's own claim was wrong. */
  declaredVersion?: string;
  sptVersion?: string;
  url?: string;
  license?: string;
  isBundleMod?: boolean;
  incompatibilities?: string[];
  dependencies?: string[];
  /**
   * The mod's FOLDER on the server, from the companion's manifest.
   *
   * `/launcher/server/loadedServerMods` reports declared names only — a stock server never tells
   * you its folder names, which is why matching has to prefer the GUID. But pulling files needs
   * the folder, since that is what the file routes are addressed by, so the companion supplies
   * it and it is carried here. Absent on a server without one.
   */
  folder?: string;
}

export interface SptServerSnapshot {
  url: string;
  reachable: boolean;
  sptVersion?: string;
  mods: SptServerMod[];
  /** Client plugins the server's Fika config declares. Empty unless the host filled it in. */
  fikaRequired: string[];
  fikaOptional: string[];
  error?: string;
  fetchedAt: string;
  /** Whether this server runs the SPTarky companion, and what it offers. */
  companion?: CompanionCapabilities;
  /**
   * The server machine's CLIENT plugins. Only ever present when the companion could actually
   * see them — undefined means "not known", which is a different thing from an empty list and
   * must not be rendered as "it has none".
   */
  clientMods?: RemoteMod[];
  /**
   * The server machine's server mods as the COMPANION sees them — including the ones sitting in
   * user/mods.disabled, which /launcher/server/loadedServerMods cannot report because it lists
   * what LOADED. Without this a mod turned off over there is indistinguishable from one that was
   * never installed, and "you have this and the server does not" is the wrong repair for it.
   */
  remoteServerMods?: RemoteMod[];
  /**
   * The server machine's addon ledger. Undefined means it has none — that machine has never
   * installed an addon through this manager — which is NOT the same as having no addons, and
   * must not be compared against as though it were.
   */
  addons?: RemoteAddon[];
  /** Gaps the companion reported while gathering, in words. */
  companionWarnings?: string[];
}

/**
 * An addon as the remote machine's ledger recorded it.
 *
 * Deliberately a narrow read of `InstalledAddonRecord` rather than the whole type: only these
 * four fields are compared, and accepting the rest would tie this to a ledger shape that belongs
 * to the other machine's version of the app.
 */
export interface RemoteAddon {
  forgeAddonId?: number;
  name: string;
  version?: string;
  parentName: string;
}

/** Normalises whatever the user typed into a base URL. Defaults to HTTPS — see above. */
export function normaliseServerUrl(input: string): { origin: string; secure: boolean } | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = "6969";
    return { origin: `${url.protocol}//${url.hostname}:${url.port}`, secure: url.protocol === "https:" };
  } catch {
    return null;
  }
}

/**
 * Certificate validation is disabled for these requests.
 *
 * SPT generates a self-signed certificate for localhost and every SPT server on earth
 * presents it, so validation cannot succeed and there is no CA to trust instead. The
 * exposure is bounded: these requests are GET-only against a host the user typed in, they
 * carry no credentials, and nothing from the response is executed. The alternative — refuse
 * to talk to any SPT server — is not one.
 */
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

/** Shared shape for callers that talk to a companion — the token header and a timeout. */
export interface ServerRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export function request(
  origin: string,
  path: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
  /**
   * `raw` turns OFF the decompression sniff below. Mandatory for file downloads: the sniff
   * decides by looking at the first byte, and a mod's own bytes can begin 0x78 by coincidence —
   * at which point a perfectly good DLL would be run through inflate. A failed inflate falls
   * back to the original, but one that SUCCEEDS on non-compressed data would corrupt the file
   * silently, and silent corruption of an installed mod is the worst outcome available here.
   */
  options?: { raw?: boolean }
): Promise<{ status: number; body: Buffer }> {
  const url = new URL(origin + path);
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path,
        method: "GET",
        timeout: timeoutMs,
        headers: { Accept: "application/json", "User-Agent": "SPTarky-Mod-Manager", ...(extraHeaders ?? {}) },
        ...(isHttps ? { agent: insecureAgent } : {})
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          let body = Buffer.concat(chunks);
          // Raw zlib regardless of Content-Encoding. Sniffed rather than trusted: 0x78 is a
          // zlib header, 0x1f8b is gzip. Skipped entirely for file downloads — see `raw` above.
          if (!options?.raw) {
            try {
              if (body[0] === 0x78) body = zlib.inflateSync(body);
              else if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
            } catch {
              /* not compressed after all — use as-is */
            }
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timed out"));
    });
    req.end();
  });
}

async function getJson(origin: string, path: string, timeoutMs: number): Promise<any> {
  const { status, body } = await request(origin, path, timeoutMs);
  if (status !== 200) throw new Error(`HTTP ${status} for ${path}`);
  const text = body.toString("utf-8").trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

/** The API wraps some responses as {"Response": ...} (the /launcher/v2 family) and some not. */
function unwrap(payload: any): any {
  return payload && typeof payload === "object" && "Response" in payload ? payload.Response : payload;
}

function toServerMod(displayName: string, raw: any): SptServerMod {
  return {
    modGuid: typeof raw?.ModGuid === "string" ? raw.ModGuid : undefined,
    name: typeof raw?.Name === "string" && raw.Name ? raw.Name : displayName,
    author: typeof raw?.Author === "string" ? raw.Author : undefined,
    version: typeof raw?.Version === "string" ? raw.Version : undefined,
    sptVersion: typeof raw?.SptVersion === "string" ? raw.SptVersion : undefined,
    url: typeof raw?.Url === "string" ? raw.Url : undefined,
    license: typeof raw?.License === "string" ? raw.License : undefined,
    isBundleMod: typeof raw?.IsBundleMod === "boolean" ? raw.IsBundleMod : undefined,
    incompatibilities: Array.isArray(raw?.Incompatibilities) ? raw.Incompatibilities.filter((x: unknown) => typeof x === "string") : undefined,
    // ModDependencies is an object keyed by GUID, not an array.
    dependencies:
      raw?.ModDependencies && typeof raw.ModDependencies === "object" ? Object.keys(raw.ModDependencies) : undefined
  };
}

/**
 * Fetches everything the app needs from a server in one go.
 *
 * Never throws: an unreachable server is an ordinary state (it is someone else's machine,
 * and it is usually off), so it is reported as `reachable: false` with the reason rather
 * than as an exception the UI has to catch.
 */
export async function fetchServerSnapshot(input: string, timeoutMs = 8000, token?: string): Promise<SptServerSnapshot> {
  const fetchedAt = new Date().toISOString();
  const parsed = normaliseServerUrl(input);
  if (!parsed) {
    return { url: input, reachable: false, mods: [], fikaRequired: [], fikaOptional: [], error: "That is not a valid address.", fetchedAt };
  }
  const { origin } = parsed;

  let sptVersion: string | undefined;
  try {
    sptVersion = unwrap(await getJson(origin, "/launcher/server/version", timeoutMs));
  } catch (err: any) {
    // The version endpoint is the reachability probe: it is tiny and present on every SPT
    // server. If it fails, nothing else is worth attempting.
    const hint =
      /ECONNREFUSED|timed out|ECONNRESET|EHOSTUNREACH/i.test(err?.message ?? "")
        ? `Could not reach ${origin}. Is the server running? (SPT 4.x uses HTTPS on 6969.)`
        : err?.message ?? "Could not reach the server.";
    return { url: origin, reachable: false, mods: [], fikaRequired: [], fikaOptional: [], error: hint, fetchedAt };
  }

  let mods: SptServerMod[] = [];
  try {
    const loaded = unwrap(await getJson(origin, "/launcher/server/loadedServerMods", timeoutMs));
    if (loaded && typeof loaded === "object") {
      mods = Object.entries(loaded).map(([displayName, raw]) => toServerMod(displayName, raw));
    }
  } catch {
    /* server reachable but not reporting mods — report what we have */
  }

  // Fika's declaration of which CLIENT plugins it requires. The server API has no way to
  // enumerate the client plugins actually installed on the host, so this is the only
  // machine-readable statement about them — and only if the host filled it in.
  let fikaRequired: string[] = [];
  let fikaOptional: string[] = [];
  try {
    const fika = await getJson(origin, "/fika/client/config", timeoutMs);
    if (Array.isArray(fika?.mods?.required)) fikaRequired = fika.mods.required.filter((x: unknown) => typeof x === "string");
    if (Array.isArray(fika?.mods?.optional)) fikaOptional = fika.mods.optional.filter((x: unknown) => typeof x === "string");
  } catch {
    /* not a Fika server, or older Fika — not an error */
  }

  // The companion, if this server has one. Everything above works without it; everything below
  // is the part a stock server cannot answer.
  const { companion, clientMods, remoteServerMods, addons, companionWarnings } = await readCompanion(origin, token, timeoutMs, mods);

  return {
    url: origin,
    reachable: true,
    sptVersion,
    mods,
    fikaRequired,
    fikaOptional,
    fetchedAt,
    companion,
    clientMods,
    remoteServerMods,
    addons,
    companionWarnings
  };
}

/**
 * Asks the server whether it runs the SPTarky companion, and uses it if so.
 *
 * Kept separate and entirely optional. Almost no server will have it, so every failure path
 * here has to leave the snapshot exactly as a stock server would produce it — the companion may
 * only ADD to what is known, never take away or throw.
 *
 * When it is present, the mods array is corrected IN PLACE from the manifest's ledger. That is
 * the whole point of the mod: /launcher/server/loadedServerMods reports what each mod DECLARES
 * about itself, which is wrong whenever an author forgets to bump it — Artem reports 3.0.0 with
 * 3.0.1 installed. The ledger on that machine recorded what was actually installed.
 */
async function readCompanion(
  origin: string,
  token: string | undefined,
  timeoutMs: number,
  mods: SptServerMod[]
): Promise<{
  companion: CompanionCapabilities;
  clientMods?: RemoteMod[];
  remoteServerMods?: RemoteMod[];
  addons?: RemoteAddon[];
  companionWarnings?: string[];
}> {
  const headers = token ? { [COMPANION_TOKEN_HEADER]: token } : undefined;

  let caps: CompanionCapabilities;
  try {
    const { status, body } = await request(origin, "/sptarky/version", timeoutMs, headers);
    const text = body.toString("utf-8").trim();
    caps = readCapabilities(status, text ? safeJson(text) : null);
  } catch {
    // Unreachable is not a finding about the companion — the server itself answered a moment
    // ago, so this is a transport hiccup, not evidence of absence.
    return { companion: NO_COMPANION };
  }

  if (!caps.present || !caps.manifest) return { companion: caps };

  try {
    const { status, body } = await request(origin, "/sptarky/manifest", timeoutMs, headers);
    if (status !== 200) return { companion: caps };
    const manifest = readManifest(safeJson(body.toString("utf-8")));
    if (!manifest) return { companion: caps };

    applyLedgerVersions(mods, manifest.serverMods);

    return {
      companion: caps,
      // Only handed over when the companion could actually SEE the client half. An empty list
      // from a server-only box would otherwise read as "this server has no client mods".
      clientMods: manifest.clientKnown ? manifest.clientMods : undefined,
      remoteServerMods: manifest.serverMods,
      // Same rule for addons: no ledger on that machine means unknown, not none.
      addons: manifest.addonsKnown ? readRemoteAddons(manifest.addons) : undefined,
      companionWarnings: manifest.warnings.length ? manifest.warnings : undefined
    };
  } catch {
    return { companion: caps };
  }
}

/**
 * Replaces declared versions with ledger-recorded ones, matching on GUID.
 *
 * GUID only, deliberately. A remote server never reports its folder names, so the two sides
 * agree on nothing else that is reliable: "WTT-CAG" on disk declares itself "WTT - Clothing and
 * Gear", and matching those by name would pair the wrong mods together.
 */
function applyLedgerVersions(mods: SptServerMod[], remote: RemoteMod[]): void {
  // Indexed by GUID for BOTH jobs below. Every entry is kept, not just ledger-backed ones,
  // because the folder name is useful even where the version is only declared — it is what the
  // file routes are addressed by, and a stock server never reports it.
  const byGuid = new Map<string, RemoteMod>();
  for (const r of remote) {
    if (r.guid) byGuid.set(r.guid.toLowerCase(), r);
  }
  if (byGuid.size === 0) return;

  for (const mod of mods) {
    if (!mod.modGuid) continue;
    const match = byGuid.get(mod.modGuid.toLowerCase());
    if (!match) continue;

    // The folder, so this mod can be pulled from the server rather than looked up.
    if (match.id) mod.folder = match.id;

    // The version the remote MANAGER recorded, which beats what the mod declares about itself.
    if (match.versionSource !== "ledger" || !match.version || match.version === mod.version) continue;
    mod.declaredVersion = mod.version;
    mod.version = match.version;
  }
}

/**
 * Narrows the remote addon ledger to the fields that are compared.
 *
 * Entries missing a name or a parent are dropped rather than repaired. An addon's identity IS
 * its name plus the mod it patches — a record without both cannot be matched against anything,
 * and carrying it forward would only produce a row that can never resolve.
 */
function readRemoteAddons(entries: unknown[]): RemoteAddon[] {
  const out: RemoteAddon[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name.trim()) continue;
    if (typeof e.parentName !== "string" || !e.parentName.trim()) continue;
    out.push({
      forgeAddonId: typeof e.forgeAddonId === "number" ? e.forgeAddonId : undefined,
      name: e.name,
      version: typeof e.version === "string" ? e.version : undefined,
      parentName: e.parentName
    });
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Presents server mods in the shape the rest of the app already understands, so the parity
 * engine and the mod list need no special case for "remote".
 *
 * `id` is the DECLARED name, because a remote server never tells us its folder names — there
 * is no filesystem to read. That is precisely why reconciliation has to prefer the GUID:
 * "WTT-CAG" on disk declares itself "WTT - Clothing and Gear", and matching those by name
 * would report two mods where there is one.
 */
export function serverModsToModInfo(snapshot: SptServerSnapshot): ModInfo[] {
  return snapshot.mods.map((mod) => ({
    id: mod.name,
    name: mod.name,
    originalName: mod.name,
    type: "server" as const,
    enabled: true, // the server only reports what it loaded; there is no inactive state here
    installedManually: false,
    loadOrder: 0,
    version: mod.version,
    author: mod.author,
    guid: mod.modGuid,
    sptVersion: mod.sptVersion
  }));
}

/* --------------------------------------------------------------------------
 * Reconciling a local install against a live server
 * ----------------------------------------------------------------------- */

export type ServerSyncIssue =
  | "missing-locally"
  | "outdated-locally"
  | "newer-locally"
  | "not-on-server"
  | "unknown-local-version"
  /** Present on disk but parked in a .disabled folder, while the server runs it. */
  | "disabled-locally"
  /** Enabled here and turned OFF on the server — again a toggle, not an install. */
  | "enabled-locally";

export interface ServerSyncRow {
  key: string;
  /** Which half this row is about. Everything but `server` needs a companion to report it. */
  side?: "server" | "client" | "addon" | "patcher";
  /** Display name — the local folder name when matched, otherwise what the server declares. */
  name: string;
  /** What the server calls it, kept when it differs so the row can be traced back. */
  serverName?: string;
  guid?: string;
  author?: string;
  serverVersion?: string;
  localVersion?: string;
  localModId?: string;
  issue?: ServerSyncIssue;
  /** How the two sides were matched. A name match is weaker and is shown as such. */
  matchedBy?: "guid" | "package" | "name";
  url?: string;
  detail?: string;
  /**
   * The mod's FOLDER name on the server — what the companion's file routes are addressed by.
   *
   * Distinct from `name`, which is chosen for a person to read, and from `serverName`, which is
   * only set when the two sides disagree. Pulling files needs the exact folder, and a display
   * name fetches nothing: Manimal's CS Gas declares itself "Manimal-CSGas" and lives in a folder
   * called "CSGas". Absent when the server could not tell us — a stock server never reports
   * folder names at all.
   */
  serverModId?: string;
  /**
   * How this row is put right. Absent means "fetch it" — install or update, the ordinary case.
   *
   * `toggle` means the files are already here and only the on/off state differs, so the repair is
   * a switch rather than a download. Kept as its own field because the UI and "Match server" both
   * have to act differently, and inferring it from the issue kind in two places is how the two
   * would eventually disagree.
   */
  fixBy?: "toggle";
  /**
   * Forge's addon id, on addon rows that came from the catalogue. Its presence is what makes an
   * addon installable in one click; without it there is nothing to look up.
   */
  forgeAddonId?: number;
  /** The mod an addon patches. Meaningless without it — an addon alone has nowhere to go. */
  parentName?: string;
  /**
   * Whether this row can be fetched, and why not when it cannot.
   *
   * Decided HERE rather than in the UI because the reason lives with the data: a client plugin
   * with no GUID cannot be looked up in the catalogue by its BepInEx folder name without risking
   * the wrong mod, and an addon with no Forge id has nothing to fetch at all. A button that
   * silently does the wrong thing is worse than one that is absent and says why.
   */
  installable?: boolean;
  notInstallableReason?: string;
}

export interface ServerSyncReport {
  reachable: boolean;
  url: string;
  sptVersion?: string;
  localSptVersion?: string;
  sptMatches?: boolean;
  error?: string;
  fetchedAt: string;
  fikaRequired: string[];
  fikaOptional: string[];
  rows: ServerSyncRow[];
  counts: {
    inSync: number;
    needUpdating: number;
    needInstalling: number;
    newerLocally: number;
    notOnServer: number;
    unknownVersion: number;
  };
  /** Whether the server runs the SPTarky companion — the versions below are only exact if so. */
  companionPresent?: boolean;
  companionVersion?: string;
  /** Why it is unusable, when reachable but not trusted. Absent on an ordinary server. */
  companionReason?: string;
  /** Client plugins on the server machine. Undefined means NOT KNOWN, not none. */
  serverClientMods?: { id: string; version?: string; enabled: boolean }[];
  /**
   * Whether the two addon ledgers could be compared at all.
   *
   * False is an ordinary state, not a fault: it means one of the machines has never installed an
   * addon through this manager. The distinction has to reach the UI, because "no addon
   * differences" and "addons were not compared" look identical in a list and mean opposite
   * things — addons routinely merge into their parent's folder and leave nothing on disk to see.
   */
  addonsCompared?: boolean;
  /**
   * Whether BepInEx/patchers could be compared. Needs a companion (to see the server's) and a
   * local scan; an empty patchers folder is a real answer, not knowing what is in it is not.
   */
  patchersCompared?: boolean;
  /**
   * Prepatcher differences, counted apart from everything else and never blocking readiness.
   * A prepatcher arrives with its parent mod and cannot be fetched on its own, so it is a
   * diagnostic rather than a task — but it still has to be SAID, or the hidden section becomes
   * a place findings go to disappear.
   */
  patcherDiffs?: number;
  /** True when nothing stands between you and joining the server. */
  readyToPlay: boolean;
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/\.dll$/, "");

/**
 * Matches the server's mods against the local install, GUID first.
 *
 * GUID is the only identifier both sides genuinely share. The server reports DECLARED names
 * ("WTT - Clothing and Gear"); the local side is folder names ("WTT-CAG"). Matching on names
 * alone reported those as two separate mods — one missing locally, one not on the server —
 * which is exactly backwards. Name matching is kept as a fallback for mods that declare no
 * GUID, and rows say which was used so a weaker match is visible.
 */
export function buildServerSyncReport(
  snapshot: SptServerSnapshot,
  localMods: ModInfo[],
  localSptVersion?: string,
  /**
   * This install's addon ledger. Undefined and empty mean different things and are kept apart:
   * undefined is "not read", which stops addons being compared at all, while an empty array is a
   * machine that genuinely has none and can legitimately be shown as missing the server's.
   */
  localAddons?: RemoteAddon[],
  /**
   * This install's BepInEx/patchers, from `scanPatchers`. Undefined skips the comparison, the
   * same way an unread addon ledger does — an empty patchers folder is a real answer, not
   * knowing what is in it is not.
   */
  localPatchers?: { id: string; enabled: boolean; version?: string }[]
): ServerSyncReport {
  const counts = { inSync: 0, needUpdating: 0, needInstalling: 0, newerLocally: 0, notOnServer: 0, unknownVersion: 0 };

  if (!snapshot.reachable) {
    return {
      reachable: false,
      url: snapshot.url,
      error: snapshot.error,
      fetchedAt: snapshot.fetchedAt,
      fikaRequired: [],
      fikaOptional: [],
      rows: [],
      counts,
      readyToPlay: false
    };
  }

  // Without the companion only server mods can be compared: /launcher/server/loadedServerMods
  // reports the server side alone, so folding client plugins in would report every one of them
  // as "not on server" — noise, not information. WITH the companion, the client half is
  // genuinely known and is compared below.
  const localServer = localMods.filter((m) => m.type === "server" && !isCompanionMod(m.id, m.guid));

  const byGuid = new Map<string, ModInfo>();
  const byName = new Map<string, ModInfo>();
  for (const mod of localServer) {
    if (mod.guid) byGuid.set(norm(mod.guid), mod);
    byName.set(norm(mod.originalName), mod);
    byName.set(norm(mod.name), mod);
  }

  /*
   * Identity for the claim set below, in ONE place.
   *
   * The two loops that share this set built the key inline, and drifted: one used a NUL byte
   * as the separator and the other a space, so nothing a matched row claimed was ever seen as
   * claimed. Every local server mod then produced BOTH a matched row and a 'not on server'
   * one — 34 mods reported as 65. Invisible in a diff, and it survived because the NUL was in
   * both halves originally and matched itself.
   */
  const claimKey = (mod: { id: string; type: string }) => `${mod.id}\u0000${mod.type}`;

  const rows: ServerSyncRow[] = [];
  const claimed = new Set<string>();

  for (const mod of snapshot.mods) {
    if (isCompanionMod(mod.name, mod.modGuid)) continue;
    const viaGuid = mod.modGuid ? byGuid.get(norm(mod.modGuid)) : undefined;
    const local = viaGuid ?? byName.get(norm(mod.name));
    const matchedBy = viaGuid ? "guid" : local ? "name" : undefined;
    if (local) claimed.add(claimKey(local));

    const row: ServerSyncRow = {
      key: norm(mod.modGuid) || norm(mod.name),
      side: "server",
      // Prefer the LOCAL folder name when the two are matched. Declared names are not
      // written for humans scanning a list: Fika's server half declares itself literally
      // "server" (GUID "Fika"), which is faithful and useless. The local name is the one
      // the user recognises, because it is the folder they installed.
      name: local?.name ?? mod.name,
      serverName: local && local.name !== mod.name ? mod.name : undefined,
      // Only the companion knows this; a stock server reports declared names only.
      serverModId: mod.folder,
      guid: mod.modGuid,
      author: mod.author,
      serverVersion: mod.version,
      localVersion: local?.version,
      localModId: local?.id,
      matchedBy,
      url: mod.url
    };

    if (!local) {
      row.issue = "missing-locally";
      row.detail = "The server runs this and you do not have it.";
      counts.needInstalling++;
    } else if (!local.version || !mod.version) {
      // Neither side can be trusted to a comparison. Saying "up to date" here would be a
      // guess dressed as a fact — some authors simply do not maintain the version in their
      // files, which is a known and separate problem.
      row.issue = "unknown-local-version";
      row.detail = local.version
        ? "The server did not report a version for this mod."
        : "This mod does not declare a version locally, so it cannot be compared.";
      counts.unknownVersion++;
    } else {
      const cmp = compareVersions(local.version, mod.version);
      if (cmp < 0) {
        row.issue = "outdated-locally";
        row.detail = `The server runs ${mod.version}; you have ${local.version}.`;
        counts.needUpdating++;
      } else if (cmp > 0) {
        row.issue = "newer-locally";
        row.detail = `You have ${local.version}; the server runs ${mod.version}. Usually harmless, but it is a mismatch.`;
        counts.newerLocally++;
      } else {
        counts.inSync++;
      }
    }
    rows.push(row);
  }

  /*
   * Local server mods the server did not load.
   *
   * "Did not load" covers two different situations, and only the companion can tell them apart:
   * either the server does not have the mod at all, or it HAS it and has it switched off. The
   * stock endpoint reports what LOADED, so both look identical through it — and "you have this
   * and the server does not" is the wrong repair for the second, which is a toggle.
   */
  const remoteDisabledServer = new Map<string, RemoteMod>();
  for (const entry of snapshot.remoteServerMods ?? []) {
    if (entry.enabled) continue;
    if (entry.guid) remoteDisabledServer.set(norm(entry.guid), entry);
    remoteDisabledServer.set(norm(entry.id), entry);
  }

  for (const mod of localServer) {
    if (claimed.has(claimKey(mod))) continue;

    const offThere =
      (mod.guid ? remoteDisabledServer.get(norm(mod.guid)) : undefined) ??
      remoteDisabledServer.get(norm(mod.originalName)) ??
      remoteDisabledServer.get(norm(mod.id));

    if (offThere && mod.enabled) {
      rows.push({
        key: norm(mod.guid) || norm(mod.originalName),
        side: "server",
        name: mod.name,
        guid: mod.guid,
        serverModId: offThere.id,
        localVersion: mod.version,
        serverVersion: offThere.version,
        localModId: mod.id,
        issue: "enabled-locally",
        fixBy: "toggle",
        detail: "The server has this mod installed but switched OFF, and you have it on. Turn it off to match."
      });
      counts.needUpdating++;
      continue;
    }

    // Off on BOTH sides is agreement, not a difference. Reporting it would put a permanent row
    // on screen for two machines that already match.
    if (offThere && !mod.enabled) {
      counts.inSync++;
      continue;
    }

    rows.push({
      key: norm(mod.guid) || norm(mod.originalName),
      side: "server",
      name: mod.name,
      guid: mod.guid,
      localVersion: mod.version,
      localModId: mod.id,
      issue: "not-on-server",
      detail: "Installed here but not loaded by the server. It will have no effect in a raid there."
    });
    counts.notOnServer++;
  }

  // --- the client half, which only the companion can report ---------------------------
  //
  // Gated on clientMods being DEFINED rather than non-empty. Undefined means the server could
  // not be asked (no companion, or no BepInEx beside it), and in that case every local plugin
  // must stay out of the report entirely — listing them all as "not on server" would be a
  // confident claim built on having no information at all.
  if (snapshot.clientMods) {
    const localClient = localMods.filter((m) => m.type !== "server");

    // Client plugins match by NAME, not GUID. The companion reports what is on disk — a folder
    // or a loose .dll — and reading the BepInPlugin GUID out of an assembly is not something it
    // does. Both sides are folder identities from the same convention, so this is a like-for-
    // like comparison rather than the name-guessing that server mods have to avoid.
    // A multimap, not a map. Several local rows routinely share one key: a plugin commonly
    // ships as BOTH `Mod.dll` and a `Mod/` folder beside it, and both reduce to the same
    // identity. Keeping only the last one silently left the other unclaimed, and it was then
    // reported as "not on server" — a mod present on both machines shown as a difference.
    // Caught by comparing a server against itself, where every row must come out in sync.
    const localByName = new Map<string, ModInfo[]>();
    const addLocal = (key: string, mod: ModInfo) => {
      const list = localByName.get(key);
      if (list) {
        if (!list.includes(mod)) list.push(mod);
      } else {
        localByName.set(key, [mod]);
      }
    };
    for (const mod of localClient) {
      addLocal(clientKey(mod.originalName), mod);
      addLocal(clientKey(mod.name), mod);
      if (mod.id) addLocal(clientKey(mod.id), mod);
    }

    /*
     * By ASSEMBLY GUID first, falling back to the folder name.
     *
     * The GUID has to be the right one, and that is the whole subtlety here. There are two, and
     * they are not the same namespace:
     *
     *   ModInfo.guid          prefers the registry's forgeGuid = the catalogue PACKAGE. It is
     *                         many-to-one against folders: HollywoodFX 2.0.0 installs BOTH
     *                         `HollywoodFX` and `HollywoodGraphics`, so the registry gives both
     *                         `com.janky.hollywoodfx`.
     *   ModInfo.assemblyGuid  the `[BepInPlugin]` attribute = ONE assembly.
     *                         `HollywoodGraphics.dll` declares `com.janky.hollywoodgraphics`.
     *
     * The companion reads `[BepInPlugin]`, so `assemblyGuid` is the like-for-like counterpart and
     * `guid` is not. Matching against `guid` made remote `HollywoodFX` match both local folders
     * and pick one by version order — which agreed, so the report looked right while the matching
     * was not. They can also be different strings entirely: `Tyfon.UIFixes.dll` declares
     * `Tyfon.UIFixes` where the catalogue says `com.tyfon.uifixes`.
     *
     * Done correctly this beats the folder name, which is a filename somebody chose and which
     * people rename to control BepInEx load order.
     *
     * A multimap, because a plugin shipping as both `Mod.dll` and a `Mod/` folder declares the
     * same assembly GUID from both halves.
     */
    const localByAssemblyGuid = new Map<string, ModInfo[]>();
    for (const mod of localClient) {
      if (!mod.assemblyGuid) continue;
      const key = norm(mod.assemblyGuid);
      const list = localByAssemblyGuid.get(key);
      if (list) list.push(mod);
      else localByAssemblyGuid.set(key, [mod]);
    }

    const claimedClient = new Set<string>();

    // Collapse the remote side by identity first. A plugin shipping as both `Mod.dll` and a
    // `Mod/` folder arrives as two entries, and emitting a row for each put the same mod on
    // screen twice — seen against the real remote server, where BlackDiv appeared as a pair.
    // The entry carrying a version wins, since the folder half usually has none.
    const remoteByKey = new Map<string, RemoteMod>();
    for (const entry of snapshot.clientMods) {
      const key = clientKey(entry.id);
      const held = remoteByKey.get(key);
      if (!held || (!held.version && entry.version)) remoteByKey.set(key, entry);
    }

    for (const remote of remoteByKey.values()) {
      // SPT ships its own files into BepInEx/plugins. They are not mods, nobody installs or
      // removes them, and reporting them would put permanent noise at the top of the list.
      if (isSptOwnedPlugin(remote.id)) continue;

      /*
       * Patchers are skipped, and this is a like-for-like problem rather than an omission.
       *
       * The companion lists every file under BepInEx/patchers individually, while the local
       * scanner folds a prepatcher into the parent mod that ships it and never lists it alone.
       * Comparing the two therefore reported mods as missing that were sitting on disk: against
       * the real remote server it produced five, and four of them — FixPluginTypesSerialization,
       * MoreBotsPrepatch, ISBSpecialForces, WTT-ContentBackportPatcher — were present locally
       * the whole time. A parity report that invents missing mods is worse than one that says
       * less, so the side that cannot see them decides what gets compared.
       */
      if (remote.area && remote.area !== "plugins") continue;

      const byAssemblyGuid = remote.guid ? localByAssemblyGuid.get(norm(remote.guid)) ?? [] : [];
      const byName = localByName.get(clientKey(remote.id)) ?? [];
      // The GUID decides the comparison, but BOTH sets are claimed. A plugin's two halves do not
      // always agree on identity — the loose `Mod.dll` declares one and the `Mod/` folder beside
      // it may hold no assembly at all — and claiming only the matched set would leave the other
      // half unaccounted for and report it as "not on server": a mod present on both machines
      // shown as a difference, which is the bug the name multimap was added for.
      const matches = byAssemblyGuid.length ? byAssemblyGuid : byName;
      for (const m of byAssemblyGuid) claimedClient.add(m.id + " " + m.type);
      for (const m of byName) claimedClient.add(m.id + " " + m.type);
      // Prefer the part that carries a version — the folder half often has none.
      const local = matches.find((m) => m.version) ?? matches[0];

      const row: ServerSyncRow = {
        key: "client:" + clientKey(remote.id),
        side: "client",
        // The FOLDER name, not the author's declared one. Every other row in this section is a
        // folder, and a lone declared name broke that column's meaning — the same mod read
        // "CSGas" in the server section and "Manimal-CSGas" here. The declared name is still
        // worth having, so it goes to the tooltip rather than the label.
        name: local?.name ?? remote.id,
        serverName: local && local.name !== remote.id ? remote.id : undefined,
        serverModId: remote.id,
        // The CATALOGUE identity, not the assembly's. This is what the Install button looks the
        // mod up with, so it has to be the identifier the catalogue understands — the remote
        // machine's ledger recorded it at install time. The `[BepInPlugin]` GUID would be the
        // wrong namespace and could resolve to a different mod entirely.
        guid: remote.catalogueGuid ?? local?.guid,
        serverVersion: remote.version,
        localVersion: local?.version,
        localModId: local?.id,
        /*
         * Three strengths, not two.
         *
         * `Tyfon.UIFixes.Net.dll` declares no `[BepInPlugin]` at all, so it can only ever be
         * matched by name — but both machines' ledgers record it as part of the same catalogue
         * package (`com.tyfon.uifixes`). That is real corroboration, and flagging it "name
         * match?" put a question mark on the one row that had install records agreeing on both
         * sides. `package` says exactly what is known: the name lined up AND both installs came
         * from the same catalogue entry.
         *
         * It cannot be promoted to a full match, because a package is many-to-one against
         * folders — UIFixes and UIFixes.Net share this very one.
         */
        matchedBy: local
          ? byAssemblyGuid.length
            ? "guid"
            : local.catalogueGuid && remote.catalogueGuid && norm(local.catalogueGuid) === norm(remote.catalogueGuid)
              ? "package"
              : "name"
          : undefined
      };

      if (!local) {
        row.issue = "missing-locally";
        row.detail = "The server machine has this client plugin and you do not.";
        counts.needInstalling++;
      } else if (local.enabled !== remote.enabled) {
        /*
         * Checked BEFORE the version, because a plugin that is switched off is not running at
         * all — which outranks it being a build behind. The repair is a toggle, not a download,
         * and treating it as "missing" would have someone reinstall a mod that is already there.
         */
        row.issue = remote.enabled ? "disabled-locally" : "enabled-locally";
        row.fixBy = "toggle";
        row.detail = remote.enabled
          ? "You have this plugin but it is switched off, and the server runs it. Turn it on to match."
          : "You have this plugin switched on and the server has it off. Turn it off to match.";
        counts.needUpdating++;
      } else if (!local.version || !remote.version) {
        row.issue = "unknown-local-version";
        row.detail = remote.version
          ? "This plugin does not declare a version locally, so it cannot be compared."
          : // Named precisely when it can be. An old companion could only report versions its
            // ledger held, so a plugin installed by hand had none — and "the server did not
            // report a version" reads like the plugin's fault rather than a missing reader.
            snapshot.companion?.clientVersions === false
            ? "The server's companion is too old to read plugin versions from the plugins themselves. Update it there to compare this."
            : "The server did not report a version for this plugin.";
        counts.unknownVersion++;
      } else {
        const cmp = compareVersions(local.version, remote.version);
        if (cmp < 0) {
          row.issue = "outdated-locally";
          row.detail = `The server machine has ${remote.version}; you have ${local.version}.`;
          counts.needUpdating++;
        } else if (cmp > 0) {
          row.issue = "newer-locally";
          row.detail = `You have ${local.version}; the server machine has ${remote.version}.`;
          counts.newerLocally++;
        } else {
          counts.inSync++;
        }
      }

      /*
       * A client plugin is fetchable only when a CATALOGUE identifier is known for it.
       *
       * The alternative is searching the catalogue for a BepInEx file name, and those are chosen
       * by whoever installed the plugin: "01-SomeMod.dll" carries a load-order prefix, and plenty
       * of plugins ship under a filename that resembles a DIFFERENT mod's name. A lookup on that
       * finds nothing, or finds the wrong mod and installs it over a working one — the shape of
       * fault that already shipped once, when preset sync fetched the newest build instead of
       * the recorded one.
       *
       * The plugin's own `[BepInPlugin]` GUID is NOT accepted here even though it is usually
       * present. It identifies an assembly, not a catalogue entry, and the two disagree often
       * enough to matter: `Tyfon.UIFixes.dll` declares `Tyfon.UIFixes` where the catalogue says
       * `com.tyfon.uifixes`. Passing one as the other is a lookup that silently matches whatever
       * happens to share the string.
       */
      if (row.issue === "missing-locally" || row.issue === "outdated-locally") {
        // The REMOTE machine's catalogue record specifically, not `row.guid`. On an outdated row
        // `row.guid` can fall back to the local mod's, and that one is catalogue-first with an
        // assembly-GUID plan B — so a locally hand-installed plugin would supply a BepInPlugin
        // GUID and put the wrong namespace back into the lookup by the side door.
        row.installable = Boolean(remote.catalogueGuid);
        if (!row.installable) {
          row.notInstallableReason =
            "The server has no catalogue record for this plugin — it was installed by hand there — so it could only be looked up by its file name, which finds the wrong mod as often as the right one. Install it by hand.";
        }
      }
      rows.push(row);
    }

    for (const mod of localClient) {
      if (claimedClient.has(mod.id + " " + mod.type)) continue;
      if (isSptOwnedPlugin(mod.id) || isSptOwnedPlugin(mod.originalName)) continue;
      rows.push({
        key: "client:" + clientKey(mod.originalName || mod.name),
        side: "client",
        name: mod.name,
        localVersion: mod.version,
        localModId: mod.id,
        issue: "not-on-server",
        // Worded carefully: a client plugin the host does not run is often FINE (cosmetics,
        // UI tweaks). Only Fika's required list makes one mandatory, and that is reported
        // separately, so this must not read as a fault.
        detail: "You have this client plugin and the server machine does not. Often harmless — only matters if the server requires matching clients."
      });
      counts.notOnServer++;
    }
  }

  /* --- prepatchers ---------------------------------------------------------------------
   *
   * Compared FOLDER TO FOLDER: BepInEx/patchers here against BepInEx/patchers there.
   *
   * They were skipped entirely until now, and the reason they had to be is worth keeping. The
   * companion lists every patcher file individually, while the local scanner folds a patcher into
   * the mod that ships it and never lists it alone — a patcher is not something anyone installs
   * or removes on its own. Comparing the companion's file list against the local MOD list
   * therefore reported mods as missing that were sitting on disk: five against the real server,
   * four of them present the whole time.
   *
   * The fix is not to unfold patchers into mods but to compare like with like. Against the same
   * server that produced those five false positives, this produces two differences and both are
   * real: a patcher disabled here and running there, and one here the server does not have.
   */
  /*
   * Prepatcher differences are counted SEPARATELY and never block readiness.
   *
   * They are not installable on their own — they arrive with the mod that ships them — and the
   * section is hidden unless asked for. Feeding them into the shared counts produced the worst
   * combination available: "Not ready", "1 to install", nothing visible in the list, and a
   * Match server button that could only fail. A state nobody can see or act on must not be the
   * thing standing between someone and a raid.
   *
   * Still reported, though — `patcherDiffs` is what the pane uses to say "look in there".
   */
  let patcherDiffs = 0;
  const patchersCompared = Boolean(snapshot.clientMods && localPatchers);
  if (snapshot.clientMods && localPatchers) {
    const localByKey = new Map<string, { id: string; enabled: boolean; version?: string }>();
    for (const p of localPatchers) {
      const key = clientKey(p.id);
      const held = localByKey.get(key);
      // An enabled copy wins over a disabled one. Both can exist at once — a leftover in
      // patchers.disabled beside a live one — and the running file is the one that matters.
      if (!held || (!held.enabled && p.enabled)) localByKey.set(key, p);
    }

    const remoteByKey = new Map<string, RemoteMod>();
    for (const entry of snapshot.clientMods) {
      if (entry.area !== "patchers") continue;
      const key = clientKey(entry.id);
      const held = remoteByKey.get(key);
      if (!held || (!held.enabled && entry.enabled)) remoteByKey.set(key, entry);
    }

    const claimedPatchers = new Set<string>();

    for (const remote of remoteByKey.values()) {
      // SPT's own prepatcher. Arrives with SPT, nobody manages it.
      if (isSptOwnedPlugin(remote.id)) continue;
      const key = clientKey(remote.id);
      const local = localByKey.get(key);
      if (local) claimedPatchers.add(key);

      const row: ServerSyncRow = {
        key: "patcher:" + key,
        side: "patcher",
        name: local?.id ?? remote.id,
        serverVersion: remote.version,
        localVersion: local?.version,
        matchedBy: local ? "name" : undefined,
        // Never installable on its own. A patcher arrives with the mod that ships it, and the
        // companion's file routes do not serve BepInEx/patchers at all — they are rooted at
        // user/mods and BepInEx/plugins. Fetching one in isolation would also be the wrong
        // repair: the parent is what is actually missing or behind.
        installable: false,
        notInstallableReason:
          "Prepatchers arrive with the mod that ships them. Install or update that mod and this comes with it."
      };

      if (!local) {
        row.issue = "missing-locally";
        row.detail =
          "The server has this prepatcher and you do not. Prepatchers arrive with the mod that ships them, so either that mod is missing here — or it was removed THERE and its patcher was left behind. A leftover on the server is the commoner of the two, and it is the server that needs tidying, not this install.";
        patcherDiffs++;
      } else if (!local.enabled && remote.enabled) {
        // Present but parked, which is its own state. "Missing" would be wrong — the file is
        // right there — and "behind" would be wrong too, since the version may match exactly.
        // A disabled prepatcher simply does not run, so the mod it belongs to behaves
        // differently here than it does there, and the fix is to enable it rather than fetch it.
        row.issue = "disabled-locally";
        row.detail = "You have this prepatcher but it is disabled, and the server runs it. Enable the mod it belongs to, or the mod will not behave the same here.";
        patcherDiffs++;
      } else if (!local.version || !remote.version) {
        row.issue = "unknown-local-version";
        row.detail = "One side reports no version for this prepatcher, so it cannot be compared.";
        patcherDiffs++;
      } else {
        const cmp = compareVersions(local.version, remote.version);
        if (cmp < 0) {
          row.issue = "outdated-locally";
          row.detail = `The server runs ${remote.version}; you have ${local.version}. Update the mod that ships it.`;
          patcherDiffs++;
        } else if (cmp > 0) {
          row.issue = "newer-locally";
          row.detail = `You have ${local.version}; the server runs ${remote.version}.`;
          patcherDiffs++;
        } else {
          /* in sync: nothing to report for a prepatcher */
        }
      }
      rows.push(row);
    }

    for (const local of localByKey.values()) {
      const key = clientKey(local.id);
      if (claimedPatchers.has(key)) continue;
      if (isSptOwnedPlugin(local.id)) continue;
      rows.push({
        key: "patcher:" + key,
        side: "patcher",
        name: local.id,
        localVersion: local.version,
        issue: "not-on-server",
        detail: "You have this prepatcher and the server does not. It patches the game before it loads, so it can change behaviour the server is not expecting."
      });
      patcherDiffs++;
    }
  }

  // --- addons, the third thing a plain server cannot answer ---------------------------
  //
  // Gated on BOTH ledgers being present, because an addon comparison is ledger against ledger and
  // nothing else. That is a real limitation rather than an implementation shortcut: most addons
  // unpack INTO their parent's folder and leave nothing of their own behind, so once installed
  // they are indistinguishable from the mod they patch. There is no scan that can find them and
  // no version to read off disk — the record written at install time is the only evidence that
  // they exist. An addon installed by hand on either machine is therefore invisible here, and
  // saying nothing about it is the only honest option.
  const addonsCompared = Boolean(snapshot.addons && localAddons);
  if (snapshot.addons && localAddons) {
    // Indexed under BOTH identities, and looked up by both. The same addon can carry a Forge id
    // on one machine and not on the other — installed from the catalogue here, from a file
    // there — and keying on only the stronger identity would then fail to match it, reporting
    // one addon as two: missing locally AND not on the server. That is the duplicate-row shape
    // the client comparison already had to be fixed for.
    const localByKey = new Map<string, RemoteAddon>();
    for (const addon of localAddons) {
      localByKey.set(nameKey(addon), addon);
      if (addon.forgeAddonId !== undefined) localByKey.set(idKey(addon.forgeAddonId), addon);
    }

    const claimedAddons = new Set<RemoteAddon>();

    for (const remote of snapshot.addons) {
      const key = addonKey(remote);
      const local =
        (remote.forgeAddonId !== undefined ? localByKey.get(idKey(remote.forgeAddonId)) : undefined) ??
        localByKey.get(nameKey(remote));
      if (local) claimedAddons.add(local);

      const row: ServerSyncRow = {
        key: "addon:" + key,
        side: "addon",
        name: remote.name,
        parentName: remote.parentName,
        forgeAddonId: remote.forgeAddonId,
        serverVersion: remote.version,
        localVersion: local?.version,
        // Matched on the Forge id when both sides have one, which is exact; otherwise on the
        // name-plus-parent pair, which is the same identity the addon ledger itself uses.
        matchedBy: remote.forgeAddonId !== undefined && local?.forgeAddonId !== undefined ? "guid" : local ? "name" : undefined
      };

      if (!local) {
        row.issue = "missing-locally";
        row.detail = `The server has this patch for ${remote.parentName} and you do not.`;
        counts.needInstalling++;
        // An addon is fetched by its catalogue id, never by name: it is not a mod in its own
        // right, and a name search would land on the parent or on nothing.
        row.installable = remote.forgeAddonId !== undefined;
        if (!row.installable) {
          row.notInstallableReason = `This addon was not installed from the catalogue on the server, so there is nothing to fetch. Get it from ${remote.parentName}'s page and install it as an addon.`;
        }
      } else if (!local.version || !remote.version) {
        row.issue = "unknown-local-version";
        row.detail = "One side recorded no version for this addon, so it cannot be compared.";
        counts.unknownVersion++;
      } else {
        const cmp = compareVersions(local.version, remote.version);
        if (cmp < 0) {
          row.issue = "outdated-locally";
          row.detail = `The server has ${remote.version} of this ${remote.parentName} patch; you have ${local.version}.`;
          counts.needUpdating++;
          row.installable = remote.forgeAddonId !== undefined;
          if (!row.installable) {
            row.notInstallableReason = `This addon did not come from the catalogue, so it cannot be updated automatically. Get it from ${remote.parentName}'s page.`;
          }
        } else if (cmp > 0) {
          row.issue = "newer-locally";
          row.detail = `You have ${local.version}; the server has ${remote.version}.`;
          counts.newerLocally++;
        } else {
          counts.inSync++;
        }
      }
      rows.push(row);
    }

    for (const local of localAddons) {
      if (claimedAddons.has(local)) continue;
      rows.push({
        key: "addon:" + addonKey(local),
        side: "addon",
        name: local.name,
        parentName: local.parentName,
        forgeAddonId: local.forgeAddonId,
        localVersion: local.version,
        issue: "not-on-server",
        detail: `You have this patch for ${local.parentName} and the server does not. It changes content locally, which can differ from what the server sends.`
      });
      counts.notOnServer++;
    }
  }

  const sptMatches =
    snapshot.sptVersion && localSptVersion ? compareVersions(snapshot.sptVersion, localSptVersion) === 0 : undefined;

  const severity: Record<string, number> = {
    "missing-locally": 0,
    "outdated-locally": 1,
    "disabled-locally": 2,
    "unknown-local-version": 3,
    "newer-locally": 3,
    "not-on-server": 4
  };
  rows.sort((a, b) => {
    const sa = a.issue ? severity[a.issue] ?? 9 : 9;
    const sb = b.issue ? severity[b.issue] ?? 9 : 9;
    return sa !== sb ? sa - sb : a.name.localeCompare(b.name);
  });

  return {
    reachable: true,
    url: snapshot.url,
    sptVersion: snapshot.sptVersion,
    localSptVersion,
    sptMatches,
    fetchedAt: snapshot.fetchedAt,
    fikaRequired: snapshot.fikaRequired,
    fikaOptional: snapshot.fikaOptional,
    companionPresent: snapshot.companion?.present ?? false,
    companionVersion: snapshot.companion?.version,
    // Only carried when there is something a person should act on. An ordinary server without
    // the companion has no "reason", and inventing one would make a normal state look broken.
    companionReason: snapshot.companion?.reason,
    serverClientMods: snapshot.clientMods?.map((m) => ({ id: m.id, version: m.version, enabled: m.enabled })),
    addonsCompared,
    patchersCompared,
    patcherDiffs,
    rows,
    counts,
    // "Newer locally" and "not on server" are mismatches worth showing but do not stop you
    // joining; a missing or outdated mod does. An SPT version mismatch always does.
    readyToPlay: counts.needInstalling === 0 && counts.needUpdating === 0 && sptMatches !== false
  };
}

/**
 * Identity for a client plugin, on both sides of the comparison.
 *
 * Drops a trailing `.dll` because the same mod is a bare folder on one machine and
 * `Mod.dll` on another depending on how it shipped, and a leading numeric ordering prefix
 * because people rename plugins to control BepInEx load order — `01-SomeMod` and `SomeMod`
 * are the same plugin and must not be reported as one missing and one extra.
 */
function clientKey(name: string | undefined): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.dll$/, "")
    .replace(/^\d+[-_.\s]+/, "");
}

/**
 * Identity for an addon, on both sides of the comparison.
 *
 * The Forge id when there is one, and name-plus-parent otherwise — the same rule the addon
 * ledger applies when deciding whether an install replaces an existing record. The parent is
 * part of the identity because addon names are not unique on their own: several mods ship a
 * patch called exactly "compatibility patch", and matching those by name alone would pair a
 * patch for one mod against a patch for another and report a version difference between two
 * unrelated things.
 */
function addonKey(addon: RemoteAddon): string {
  return addon.forgeAddonId !== undefined ? idKey(addon.forgeAddonId) : nameKey(addon);
}

function idKey(forgeAddonId: number): string {
  return `id:${forgeAddonId}`;
}

function nameKey(addon: RemoteAddon): string {
  return `n:${addon.name.trim().toLowerCase()}|${addon.parentName.trim().toLowerCase()}`;
}

/**
 * SPT's own files under BepInEx/plugins, which are not mods.
 *
 * They arrive with SPT itself, nobody installs or removes them, and on a healthy pair of
 * machines they always differ in uninteresting ways — so reporting them would put permanent
 * noise at the top of a list whose whole job is to show what needs attention.
 */
function isSptOwnedPlugin(name: string | undefined): boolean {
  const key = clientKey(name);
  return key === "spt" || key.startsWith("spt-") || key.startsWith("spt.");
}

/**
 * The SPTarky companion itself, which must never appear in a parity report.
 *
 * It is infrastructure this manager installs, not a mod anyone chose, and whether a given
 * machine has it is a deliberate per-machine decision — the server needs it, a plain client
 * does not. Comparing the two therefore produces a difference that is always expected and
 * never actionable, and the header already reports its presence on both sides properly.
 *
 * Matched on GUID first, since that survives someone renaming the folder.
 */
function isCompanionMod(name?: string, guid?: string): boolean {
  if (guid && guid.trim().toLowerCase() === "com.sptarky.companion") return true;
  return (name ?? "").trim().toLowerCase() === "sptarkycompanion";
}
