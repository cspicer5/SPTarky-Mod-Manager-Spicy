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

export interface SptServerMod {
  modGuid?: string;
  name: string;
  author?: string;
  version?: string;
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

function request(origin: string, path: string, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
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
        headers: { Accept: "application/json", "User-Agent": "SPTarky-Mod-Manager" },
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
export async function fetchServerSnapshot(input: string, timeoutMs = 8000): Promise<SptServerSnapshot> {
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

  return { url: origin, reachable: true, sptVersion, mods, fikaRequired, fikaOptional, fetchedAt };
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

  // Only server mods can be compared: /launcher/server/loadedServerMods reports the server
  // side alone. Client plugins are invisible to it, so folding them in would report every
  // one of them as "not on server" — noise, not information.
  const localServer = localMods.filter((m) => m.type === "server");

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
    const viaGuid = mod.modGuid ? byGuid.get(norm(mod.modGuid)) : undefined;
    const local = viaGuid ?? byName.get(norm(mod.name));
    const matchedBy = viaGuid ? "guid" : local ? "name" : undefined;
    if (local) claimed.add(local.id + " " + local.type);

    const row: ServerSyncRow = {
      key: norm(mod.modGuid) || norm(mod.name),
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
      name: mod.name,
      guid: mod.guid,
      localVersion: mod.version,
      localModId: mod.id,
      issue: "not-on-server",
      detail: "Installed here but not loaded by the server. It will have no effect in a raid there."
    });
    counts.notOnServer++;
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
    rows,
    counts,
    // "Newer locally" and "not on server" are mismatches worth showing but do not stop you
    // joining; a missing or outdated mod does. An SPT version mismatch always does.
    readyToPlay: counts.needInstalling === 0 && counts.needUpdating === 0 && sptMatches !== false
  };
}
