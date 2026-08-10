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
  /** Gaps the companion reported while gathering, in words. */
  companionWarnings?: string[];
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

function request(
  origin: string,
  path: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string>
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
          // zlib header, 0x1f8b is gzip.
          try {
            if (body[0] === 0x78) body = zlib.inflateSync(body);
            else if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
          } catch {
            /* not compressed after all — use as-is */
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
  const { companion, clientMods, companionWarnings } = await readCompanion(origin, token, timeoutMs, mods);

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
): Promise<{ companion: CompanionCapabilities; clientMods?: RemoteMod[]; companionWarnings?: string[] }> {
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
  const byGuid = new Map<string, RemoteMod>();
  for (const r of remote) {
    if (r.guid && r.versionSource === "ledger" && r.version) byGuid.set(r.guid.toLowerCase(), r);
  }
  if (byGuid.size === 0) return;

  for (const mod of mods) {
    if (!mod.modGuid) continue;
    const match = byGuid.get(mod.modGuid.toLowerCase());
    if (!match?.version || match.version === mod.version) continue;
    mod.declaredVersion = mod.version;
    mod.version = match.version;
  }
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
  | "unknown-local-version";

export interface ServerSyncRow {
  key: string;
  /** Which half this row is about. Client rows appear only when a companion reported them. */
  side?: "server" | "client";
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
  matchedBy?: "guid" | "name";
  url?: string;
  detail?: string;
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
  localSptVersion?: string
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

  const rows: ServerSyncRow[] = [];
  const claimed = new Set<string>();

  for (const mod of snapshot.mods) {
    if (isCompanionMod(mod.name, mod.modGuid)) continue;
    const viaGuid = mod.modGuid ? byGuid.get(norm(mod.modGuid)) : undefined;
    const local = viaGuid ?? byName.get(norm(mod.name));
    const matchedBy = viaGuid ? "guid" : local ? "name" : undefined;
    if (local) claimed.add(local.id + " " + local.type);

    const row: ServerSyncRow = {
      key: norm(mod.modGuid) || norm(mod.name),
      side: "server",
      // Prefer the LOCAL folder name when the two are matched. Declared names are not
      // written for humans scanning a list: Fika's server half declares itself literally
      // "server" (GUID "Fika"), which is faithful and useless. The local name is the one
      // the user recognises, because it is the folder they installed.
      name: local?.name ?? mod.name,
      serverName: local && local.name !== mod.name ? mod.name : undefined,
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

  for (const mod of localServer) {
    if (claimed.has(mod.id + " " + mod.type)) continue;
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

      const matches = localByName.get(clientKey(remote.id)) ?? [];
      // Every local part sharing this identity is accounted for, not just the one shown.
      for (const m of matches) claimedClient.add(m.id + " " + m.type);
      // Prefer the part that carries a version — the folder half often has none.
      const local = matches.find((m) => m.version) ?? matches[0];

      const row: ServerSyncRow = {
        key: "client:" + clientKey(remote.id),
        side: "client",
        name: local?.name ?? remote.id,
        serverName: local && local.name !== remote.id ? remote.id : undefined,
        serverVersion: remote.version,
        localVersion: local?.version,
        localModId: local?.id,
        matchedBy: local ? "name" : undefined
      };

      if (!local) {
        row.issue = "missing-locally";
        row.detail = "The server machine has this client plugin and you do not.";
        counts.needInstalling++;
      } else if (!local.version || !remote.version) {
        row.issue = "unknown-local-version";
        row.detail = remote.version
          ? "This plugin does not declare a version locally, so it cannot be compared."
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

  const sptMatches =
    snapshot.sptVersion && localSptVersion ? compareVersions(snapshot.sptVersion, localSptVersion) === 0 : undefined;

  const severity: Record<string, number> = {
    "missing-locally": 0,
    "outdated-locally": 1,
    "unknown-local-version": 2,
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
