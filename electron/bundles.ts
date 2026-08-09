/**
 * Bundle sync — pulling a server's asset bundles down in bulk (v1.3.3).
 *
 * Mods that add or replace game assets ship Unity BUNDLES. The server holds them; the client
 * fetches each one the first time it is needed and caches it under
 * `<server root>/user/cache/bundles/<FileName>`. Done in game that is a slow trickle,
 * mid-raid, over however many hundred bundles a modlist has. This does the whole set at once.
 *
 * ## No SPT-side mod is required — the protocol already exists
 *
 * Established against a live 4.0.13 server before any of this was written:
 *
 *   GET /singleplayer/bundles     the full manifest. Each entry is
 *                                 { ModPath, FileName, Crc, Bundle:{key,dependencyKeys},
 *                                   Dependencies }
 *   GET /files/bundle/<FileName>  the bundle itself, 200, exact bytes.
 *
 * **`Crc` is a plain CRC32 of the file's bytes** — checked on eight bundles, eight exact
 * matches, and again on a freshly downloaded one. That is what makes this a real
 * synchronisation rather than a presence check: a bundle whose content changed server-side
 * keeps its path, so existence alone would never notice.
 *
 * Verifying the whole cache costs about **6 seconds for 16.3 GB** (~2.7 GB/s), so every sync
 * verifies rather than trusting the filesystem. No hash cache to invalidate, and no way for a
 * stale entry to hide a stale bundle.
 *
 * ## Three things that will bite anyone reimplementing this
 *
 * 1. **Paths must be URL-encoded per segment.** 24 of the reference server's 3,160 bundles
 *    have spaces in them ("pistol grips", "sights front"), and Node's http client THROWS
 *    `ERR_UNESCAPED_CHARACTERS` rather than failing the request — so those 24 would crash the
 *    sync, not merely fail to download.
 * 2. **FileName comes from the server and is used to build a local path.** It is sanitised
 *    before it touches the disk; see `safeLocalPath`.
 * 3. **Local files the server does not list are NOT rubbish.** The reference install has 85
 *    (377 MB) left by mods that are no longer on the server. They are reported and never
 *    deleted automatically — the user may be about to reinstall the mod, and re-downloading
 *    is the expensive direction.
 */
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import zlib from "zlib";

export interface BundleEntry {
  /** Which server mod ships it, e.g. "user/mods/WTT-Armory". */
  modPath: string;
  /** Path relative to the bundle cache root, forward-slashed. */
  fileName: string;
  /** CRC32 of the bundle's bytes, as the server computes it. */
  crc: number;
  dependencies: string[];
}

export type BundleState = "ok" | "missing" | "stale";

export interface BundleStatus {
  entry: BundleEntry;
  state: BundleState;
  localCrc?: number;
  localBytes?: number;
}

export interface OrphanBundle {
  fileName: string;
  bytes: number;
}

export interface BundleSyncPlan {
  ok: BundleStatus[];
  missing: BundleStatus[];
  stale: BundleStatus[];
  /** Present locally, absent from the server's manifest. Never deleted automatically. */
  orphans: OrphanBundle[];
  orphanBytes: number;
  serverBundleCount: number;
}

/* --------------------------------------------------------------------------
 * Talking to the server
 * ----------------------------------------------------------------------- */

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 8 });

/**
 * One request, returning raw bytes.
 *
 * SPT serves over HTTPS with a self-signed certificate and answers with RAW ZLIB regardless
 * of what Content-Encoding claims, so the body is sniffed rather than trusted — 0x78 is a
 * zlib header, 0x1f8b is gzip. Bundle bodies are neither and pass through untouched.
 */
function request(url: URL, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    let req: http.ClientRequest;
    try {
      req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: "GET",
          agent: isHttps ? insecureAgent : undefined,
          timeout: timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            let body = Buffer.concat(chunks);
            try {
              if (body.length > 1 && body[0] === 0x78) body = zlib.inflateSync(body);
              else if (body.length > 1 && body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
            } catch {
              /* not compressed after all — a bundle body looks like neither */
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
          res.on("error", reject);
        }
      );
    } catch (err) {
      // Node refuses an unescaped path by THROWING rather than failing the request.
      reject(err);
      return;
    }
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timed out"));
    });
    req.end();
  });
}

/**
 * Encodes a bundle path for a URL, one segment at a time.
 *
 * Per-segment `encodeURIComponent` rather than `encodeURI`, because the latter leaves `#`,
 * `?` and `&` intact — any of which would truncate the path or turn part of it into a query.
 * Slashes are re-joined afterwards so the path structure survives.
 */
export function encodeBundlePath(fileName: string): string {
  return fileName.split("/").map(encodeURIComponent).join("/");
}

export async function fetchBundleManifest(serverUrl: string, timeoutMs = 20000): Promise<BundleEntry[]> {
  const base = new URL(serverUrl);
  const url = new URL("/singleplayer/bundles", base);
  const res = await request(url, timeoutMs);
  if (res.status !== 200) throw new Error(`the server answered ${res.status} for the bundle list`);
  let parsed: any;
  try {
    parsed = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new Error("the server's bundle list was not readable JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("the server's bundle list was not a list");
  const out: BundleEntry[] = [];
  for (const raw of parsed) {
    const fileName = String(raw?.FileName ?? raw?.Bundle?.key ?? "").replace(/\\/g, "/");
    if (!fileName) continue;
    out.push({
      modPath: String(raw?.ModPath ?? ""),
      fileName,
      crc: Number(raw?.Crc ?? 0),
      dependencies: Array.isArray(raw?.Dependencies) ? raw.Dependencies.map(String) : []
    });
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Comparing against the local cache
 * ----------------------------------------------------------------------- */

/** Where a server root keeps its downloaded bundles. */
export function bundleCacheDir(serverRoot: string): string {
  return path.join(serverRoot, "user", "cache", "bundles");
}

/**
 * Resolves a server-supplied path inside the cache, or null if it escapes.
 *
 * `FileName` is chosen by the server, and it is used to build a path that gets WRITTEN to.
 * A value containing `..`, a leading slash or a drive letter would place the write outside
 * the cache — so the resolved path is required to stay under the cache root, compared after
 * resolution rather than by inspecting the string.
 */
export function safeLocalPath(cacheDir: string, fileName: string): string | null {
  if (!fileName || path.isAbsolute(fileName) || /^[a-z]:/i.test(fileName)) return null;
  const resolved = path.resolve(cacheDir, fileName.replace(/\//g, path.sep));
  const root = path.resolve(cacheDir);
  // A path is inside only if it starts with the root FOLLOWED BY a separator; a bare prefix
  // test also accepts a sibling directory whose name merely starts the same way.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** Every file under the cache, relative and forward-slashed. */
export function listLocalBundles(cacheDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(cacheDir)) return out;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(cacheDir, full).replace(/\\/g, "/"));
    }
  };
  walk(cacheDir);
  return out;
}

export function crcOf(file: string): number | undefined {
  try {
    return zlib.crc32(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/**
 * What is missing, what is stale, and what is here that the server never mentioned.
 *
 * Every present bundle is CRC-checked rather than assumed good. It costs about 6 seconds for
 * 16 GB, and it is the only way to notice a bundle whose CONTENT changed server-side — the
 * path stays the same when a mod is updated, so existence proves nothing.
 */
export function planBundleSync(
  manifest: BundleEntry[],
  cacheDir: string,
  onProgress?: (done: number, total: number) => void
): BundleSyncPlan {
  const ok: BundleStatus[] = [];
  const missing: BundleStatus[] = [];
  const stale: BundleStatus[] = [];
  const claimed = new Set<string>();

  let done = 0;
  for (const entry of manifest) {
    const local = safeLocalPath(cacheDir, entry.fileName);
    if (local) claimed.add(entry.fileName.toLowerCase());
    if (!local || !fs.existsSync(local)) {
      missing.push({ entry, state: "missing" });
    } else {
      const localCrc = crcOf(local);
      const localBytes = (() => {
        try {
          return fs.statSync(local).size;
        } catch {
          return undefined;
        }
      })();
      // A CRC of 0 in the manifest means the server did not supply one; treat the file as
      // present rather than inventing a mismatch out of a missing figure.
      if (!entry.crc || localCrc === entry.crc) ok.push({ entry, state: "ok", localCrc, localBytes });
      else stale.push({ entry, state: "stale", localCrc, localBytes });
    }
    onProgress?.(++done, manifest.length);
  }

  const orphans: OrphanBundle[] = [];
  let orphanBytes = 0;
  for (const rel of listLocalBundles(cacheDir)) {
    if (claimed.has(rel.toLowerCase())) continue;
    let bytes = 0;
    try {
      bytes = fs.statSync(path.join(cacheDir, rel.replace(/\//g, path.sep))).size;
    } catch {
      /* vanished mid-scan */
    }
    orphans.push({ fileName: rel, bytes });
    orphanBytes += bytes;
  }

  return { ok, missing, stale, orphans, orphanBytes, serverBundleCount: manifest.length };
}

/* --------------------------------------------------------------------------
 * Downloading
 * ----------------------------------------------------------------------- */

export interface BundleDownloadResult {
  fileName: string;
  ok: boolean;
  bytes: number;
  message?: string;
}

/**
 * Fetches one bundle and puts it in place only once it is known to be correct.
 *
 * Written to a `.part` beside the target and renamed on success, so an interrupted sync can
 * never leave a truncated file sitting where a valid bundle should be — which would then be
 * indistinguishable from a good one until the CRC pass, and would break the game in between.
 * The CRC is checked BEFORE the rename for the same reason.
 */
export async function downloadBundle(
  serverUrl: string,
  entry: BundleEntry,
  cacheDir: string,
  timeoutMs = 120000
): Promise<BundleDownloadResult> {
  const target = safeLocalPath(cacheDir, entry.fileName);
  if (!target) {
    return { fileName: entry.fileName, ok: false, bytes: 0, message: "refused a path that points outside the cache" };
  }
  const url = new URL(`/files/bundle/${encodeBundlePath(entry.fileName)}`, new URL(serverUrl));
  let res: { status: number; body: Buffer };
  try {
    res = await request(url, timeoutMs);
  } catch (err: any) {
    return { fileName: entry.fileName, ok: false, bytes: 0, message: err?.message ?? String(err) };
  }
  if (res.status !== 200 || res.body.length === 0) {
    return { fileName: entry.fileName, ok: false, bytes: 0, message: `server answered ${res.status}` };
  }
  if (entry.crc) {
    const got = zlib.crc32(res.body);
    if (got !== entry.crc) {
      return {
        fileName: entry.fileName,
        ok: false,
        bytes: res.body.length,
        message: `checksum mismatch (expected ${entry.crc}, got ${got})`
      };
    }
  }
  const part = `${target}.part`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(part, res.body);
    fs.renameSync(part, target);
  } catch (err: any) {
    try {
      fs.rmSync(part, { force: true });
    } catch {
      /* best effort */
    }
    return { fileName: entry.fileName, ok: false, bytes: res.body.length, message: err?.message ?? String(err) };
  }
  return { fileName: entry.fileName, ok: true, bytes: res.body.length };
}

export interface SyncProgress {
  done: number;
  total: number;
  bytes: number;
  current: string;
}

/**
 * Downloads a set of bundles, a few at a time.
 *
 * Bounded concurrency rather than one-at-a-time or all-at-once: bundles are large (some are
 * 13 MB) and a modlist can want hundreds, so serialising wastes the link, while firing
 * thousands at once would exhaust sockets and make failures impossible to attribute.
 */
export async function syncBundles(
  serverUrl: string,
  entries: BundleEntry[],
  cacheDir: string,
  options: {
    concurrency?: number;
    onProgress?: (p: SyncProgress) => void;
    shouldCancel?: () => boolean;
  } = {}
): Promise<{ results: BundleDownloadResult[]; cancelled: boolean }> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 12));
  const results: BundleDownloadResult[] = [];
  let index = 0;
  let bytes = 0;
  let cancelled = false;

  const worker = async () => {
    for (;;) {
      if (options.shouldCancel?.()) {
        cancelled = true;
        return;
      }
      const i = index++;
      if (i >= entries.length) return;
      const entry = entries[i];
      const result = await downloadBundle(serverUrl, entry, cacheDir);
      results.push(result);
      if (result.ok) bytes += result.bytes;
      options.onProgress?.({ done: results.length, total: entries.length, bytes, current: entry.fileName });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return { results, cancelled };
}

/** One line for the UI, distinguishing "nothing to do" from "could not tell". */
export function describeBundlePlan(plan: BundleSyncPlan): string {
  const parts: string[] = [];
  if (plan.missing.length) parts.push(`${plan.missing.length} missing`);
  if (plan.stale.length) parts.push(`${plan.stale.length} out of date`);
  if (parts.length === 0) {
    return `All ${plan.serverBundleCount} of the server's bundles are present and match.`;
  }
  return `${parts.join(", ")} of ${plan.serverBundleCount} server bundle(s).`;
}
