/**
 * Mod presets — phase 3: payloads.
 *
 * This is the part that removes Forge from the equation. A phase 2 preset names mods and
 * leaves you to find them; after Forge shuts down on 2026-08-10 that is a treasure hunt with
 * no map. A preset that CARRIES the mods needs no catalogue, no downloads, and no network
 * beyond reaching the store folder.
 *
 *   <store>/mods/
 *     SAIN@4.4.3/
 *       payload.json              what this is, and the hash proving it
 *       BepInEx/plugins/SAIN/…    mirrors the install layout, so applying is a copy
 *     WTT-Armory@2.0.5/
 *       user/mods/WTT-Armory/…
 *
 * ## Deduplication is mandatory, not an optimisation
 *
 * The reference install is 17.8 GB across 54 mods (WTT-ContentBackport alone is 4.76 GB in
 * 1179 files). Storing payloads per preset would cost that much for the first preset and
 * roughly again for the second, even if they shared 90% of their mods. Payloads are keyed by
 * content and stored once, so a second preset costs only what it does not share.
 *
 * ## Why the key carries a hash
 *
 * `<name>@<version>` alone is unsound, and for the exact reason the version ledger exists: a
 * declared version is not evidence of which build you have. If two people publish different
 * builds both calling themselves SAIN@4.4.3, the second publish would see the key already
 * present, skip the copy, and silently ship the FIRST person's files under the second
 * person's preset. So a payload records a content hash, and a colliding key with a different
 * hash is stored as `<name>@<version>+<hash8>` rather than being merged.
 *
 * The manifest points at the exact key, so a preset always resolves to the bytes it was
 * built from.
 *
 * ## Hashing is affordable HERE and nowhere else
 *
 * The scan-time fingerprint is deliberately stat-only, because hashing 4.76 GB on every scan
 * would make scanning unusable. Publishing already reads every byte in order to copy it, so
 * the hash is computed DURING the copy — one read, not two.
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { ModInfo, ModType } from "./types";
import {
  SERVER_MODS_DIR,
  SERVER_MODS_DISABLED_DIR,
  CLIENT_PLUGINS_DIR,
  CLIENT_PLUGINS_DISABLED_DIR,
  CLIENT_PATCHERS_DIR,
  CLIENT_PATCHERS_DISABLED_DIR,
  findRelatedPatcherFiles,
  isProtectedClientEntry
} from "./modManager";

export const PAYLOAD_SCHEMA = 1;

/* --------------------------------------------------------------------------
 * Gathering a mod's complete file set
 * ----------------------------------------------------------------------- */

/** One file, with the path it occupies relative to an install root. */
export interface PayloadFile {
  /** Absolute path to read from. */
  source: string;
  /** Install-relative destination, always in the ENABLED layout. Forward slashes. */
  rel: string;
  size: number;
}

const toPosix = (s: string) => s.split(path.sep).join("/");

function walkFiles(dir: string, relBase: string, out: PayloadFile[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      walkFiles(abs, rel, out);
    } else if (entry.isFile()) {
      out.push({ source: abs, rel, size: fs.statSync(abs).size });
    }
  }
}

function addPath(abs: string, rel: string, out: PayloadFile[]): void {
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) walkFiles(abs, rel, out);
  else out.push({ source: abs, rel, size: stat.size });
}

/**
 * Every file that belongs to a mod, as install-relative paths.
 *
 * Paths are recorded in the ENABLED layout regardless of where the files currently sit. A
 * preset that deliberately ships a mod disabled would otherwise need a second, byte-identical
 * payload under `plugins.disabled/` — defeating the deduplication that makes this viable at
 * all. Which state it lands in is the preset's business, decided at apply time.
 *
 * The rules for what belongs to a mod (companion folders, prepatchers, BepInEx config) are
 * imported from modManager rather than restated. Two descriptions of "this mod's files"
 * WILL drift, and the one that drifts is the one nobody is looking at.
 */
export function collectModPayloadFiles(
  clientRoot: string,
  serverRoot: string,
  mod: Pick<ModInfo, "id" | "type" | "enabled" | "guid" | "name">
): PayloadFile[] {
  const files: PayloadFile[] = [];

  if (mod.type === "server") {
    const dir = path.join(serverRoot, ...(mod.enabled ? SERVER_MODS_DIR : SERVER_MODS_DISABLED_DIR));
    addPath(path.join(dir, mod.id), `${SERVER_MODS_DIR.join("/")}/${mod.id}`, files);
    return files;
  }

  if (isProtectedClientEntry(mod.id)) return files; // SPT's own core is never a mod

  const pluginsDir = path.join(clientRoot, ...(mod.enabled ? CLIENT_PLUGINS_DIR : CLIENT_PLUGINS_DISABLED_DIR));
  const pluginsRel = CLIENT_PLUGINS_DIR.join("/");
  addPath(path.join(pluginsDir, mod.id), `${pluginsRel}/${mod.id}`, files);

  // "Mod.dll" often owns a "Mod/" folder holding its assets. Copying only the DLL leaves the
  // plugin loading against nothing.
  const base = mod.id.replace(/\.dll$/i, "");
  if (base && base !== mod.id) {
    addPath(path.join(pluginsDir, base), `${pluginsRel}/${base}`, files);
  }

  // Prepatchers run before BepInEx and live in their own directory. A mod split across both
  // is half-installed without them — the same reasoning as the toggle cascade.
  for (const dirParts of [CLIENT_PATCHERS_DIR, CLIENT_PATCHERS_DISABLED_DIR]) {
    const from = path.join(clientRoot, ...dirParts);
    for (const patcher of findRelatedPatcherFiles(from, mod.id)) {
      addPath(patcher, `${CLIENT_PATCHERS_DIR.join("/")}/${path.basename(patcher)}`, files);
    }
  }

  // BepInEx names a config after the plugin's GUID ("com.tyfon.uifixes.cfg"), though some use
  // the mod's name. Without it the receiving install runs the right mod with default
  // settings, which looks like the mod misbehaving rather than like a missing file.
  const configDir = path.join(clientRoot, "BepInEx", "config");
  if (fs.existsSync(configDir)) {
    const wanted = new Set(
      [mod.guid, base, mod.name].filter((x): x is string => !!x).map((x) => `${x.toLowerCase()}.cfg`)
    );
    for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
        files.push({
          source: path.join(configDir, entry.name),
          rel: `BepInEx/config/${entry.name}`,
          size: fs.statSync(path.join(configDir, entry.name)).size
        });
      }
    }
  }

  // Deterministic order, so the same mod always hashes to the same value.
  const seen = new Set<string>();
  return files
    .filter((f) => (seen.has(f.rel.toLowerCase()) ? false : (seen.add(f.rel.toLowerCase()), true)))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/* --------------------------------------------------------------------------
 * Keys and manifests
 * ----------------------------------------------------------------------- */

export interface PayloadManifest {
  schema: number;
  key: string;
  name: string;
  version?: string;
  type: ModType;
  guid?: string;
  /** Content hash over every file's path and bytes. The payload's real identity. */
  hash: string;
  files: number;
  bytes: number;
  createdAt: string;
  /** Recorded because publishing redistributes someone else's work — see docs/PRESETS.md. */
  license?: string;
  sourceUrl?: string;
}

/** Filesystem-safe: a folder name cannot contain the characters a version might. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9._@+-]+/g, "_").slice(0, 80);

/**
 * `<type>_<name>@<version>`, optionally `+<hash8>`.
 *
 * The type prefix is not decoration. Plenty of mods ship a server half and a client half
 * under ONE folder name — acidphantasm-botplacementsystem, WTT-PackNStrap and
 * showmethemoney all do on the reference install — so keying on name and version alone puts
 * two different things at one address. The hash suffix would in practice keep them apart,
 * but only as a side effect of their contents differing; relying on that makes a structural
 * distinction depend on a coincidence, which is precisely how the headless parity report
 * once let server rows overwrite client rows. A colon would read better but is illegal in a
 * Windows filename.
 *
 * The hash suffix means something different: it appears only when a genuinely DIFFERENT
 * build already holds the plain key, so the common case stays readable and dedup still works.
 */
export function payloadKey(name: string, version?: string, type?: ModType, hash?: string): string {
  const side = type === "server" ? "server" : "client";
  const base = `${side}_${safe(name)}@${safe(version || "unknown")}`;
  return hash ? `${base}+${hash.slice(0, 8)}` : base;
}

const payloadsDir = (storeDir: string) => path.join(storeDir, "mods");
const payloadDir = (storeDir: string, key: string) => path.join(payloadsDir(storeDir), key);
const stagingDir = (storeDir: string, key: string) => path.join(payloadsDir(storeDir), ".staging", key);

export async function readPayloadManifest(storeDir: string, key: string): Promise<PayloadManifest | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(payloadDir(storeDir, key), "payload.json"), "utf-8"));
    return raw?.schema === PAYLOAD_SCHEMA ? (raw as PayloadManifest) : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Copying in
 * ----------------------------------------------------------------------- */

export interface PayloadProgress {
  /** Which mod, so a 45-minute copy says what it is doing. */
  mod: string;
  file: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

/**
 * Streams one file, hashing as it copies.
 *
 * Streamed rather than `copyFile` because a 4.76 GB mod must not be read twice — once to
 * copy and once to hash — and must not be held in memory at all.
 */
async function copyAndHashFile(source: string, target: string): Promise<string> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const read = fs.createReadStream(source);
    const write = fs.createWriteStream(target);
    read.on("error", reject);
    write.on("error", reject);
    read.on("data", (chunk) => hash.update(chunk));
    write.on("finish", () => resolve());
    read.pipe(write);
  });
  return hash.digest("hex");
}

/**
 * Combines per-file hashes into one identity for the whole payload.
 *
 * Path AND content, so moving a file between two locations changes the result — a mod whose
 * DLL moved from plugins/ to patchers/ is not the same mod, even with identical bytes.
 */
function combineHashes(entries: { rel: string; hash: string }[]): string {
  const total = crypto.createHash("sha256");
  for (const e of [...entries].sort((a, b) => a.rel.localeCompare(b.rel))) {
    total.update(e.rel.toLowerCase());
    total.update("\0");
    total.update(e.hash);
    total.update("\0");
  }
  return total.digest("hex");
}

export interface StorePayloadResult {
  success: boolean;
  message: string;
  key?: string;
  manifest?: PayloadManifest;
  /** True when an identical payload was already in the store and nothing was copied. */
  reused?: boolean;
  bytesCopied?: number;
}

/**
 * Copies a mod's file set into the store, keyed by content.
 *
 * Staged into `mods/.staging/<key>/` and renamed into place, because a directory rename is
 * the closest thing to an atomic commit a shared folder offers. A partially copied 4.7 GB mod
 * must never be visible to someone applying a preset at that moment — it would look complete
 * and install a mod with holes in it.
 *
 * Resumable: staging is keyed deterministically, and a file already staged at the right size
 * is skipped. A LAN copy of 17.8 GB that dies at 80% resumes rather than restarting.
 */
export async function storePayload(
  storeDir: string,
  files: PayloadFile[],
  meta: { name: string; version?: string; type: ModType; guid?: string; license?: string; sourceUrl?: string },
  onProgress?: (p: PayloadProgress) => void,
  isCancelled?: () => boolean
): Promise<StorePayloadResult> {
  if (files.length === 0) {
    return { success: false, message: `No files found for "${meta.name}" — nothing to publish.` };
  }

  const plainKey = payloadKey(meta.name, meta.version, meta.type);
  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0);
  const staging = stagingDir(storeDir, plainKey);

  try {
    await fsp.mkdir(staging, { recursive: true });

    const hashes: { rel: string; hash: string }[] = [];
    let filesDone = 0;
    let bytesDone = 0;
    let bytesCopied = 0;

    for (const file of files) {
      if (isCancelled?.()) {
        return { success: false, message: `Cancelled while copying "${meta.name}". Progress is kept for next time.` };
      }
      const target = path.join(staging, ...file.rel.split("/"));

      // Already staged at the right size by an interrupted run: hash it without re-copying.
      let hash: string | null = null;
      try {
        const existing = await fsp.stat(target);
        if (existing.size === file.size) hash = await hashExistingFile(target);
      } catch {
        /* not staged yet */
      }
      if (!hash) {
        hash = await copyAndHashFile(file.source, target);
        bytesCopied += file.size;
      }

      hashes.push({ rel: file.rel, hash });
      filesDone++;
      bytesDone += file.size;
      onProgress?.({ mod: meta.name, file: file.rel, filesDone, filesTotal: files.length, bytesDone, bytesTotal });
    }

    const hash = combineHashes(hashes);

    // Where this lands. If the plain key is free, or already holds THIS content, use it.
    // Otherwise a different build is already parked there and the hash disambiguates —
    // silently merging them is how one person's preset ships another person's files.
    let key = plainKey;
    const existing = await readPayloadManifest(storeDir, plainKey);
    if (existing && existing.hash !== hash) {
      key = payloadKey(meta.name, meta.version, meta.type, hash);
    }

    const already = await readPayloadManifest(storeDir, key);
    if (already && already.hash === hash) {
      await fsp.rm(staging, { recursive: true, force: true });
      return {
        success: true,
        key,
        manifest: already,
        reused: true,
        bytesCopied: 0,
        message: `"${meta.name}" is already in the store.`
      };
    }

    const manifest: PayloadManifest = {
      schema: PAYLOAD_SCHEMA,
      key,
      name: meta.name,
      version: meta.version,
      type: meta.type,
      guid: meta.guid,
      hash,
      files: files.length,
      bytes: bytesTotal,
      createdAt: new Date().toISOString(),
      license: meta.license,
      sourceUrl: meta.sourceUrl
    };
    // Written INSIDE staging, so the rename publishes the payload and its proof together.
    // A payload visible without its manifest could not be verified by anyone.
    await fsp.writeFile(path.join(staging, "payload.json"), JSON.stringify(manifest, null, 2), "utf-8");

    const final = payloadDir(storeDir, key);
    await fsp.mkdir(path.dirname(final), { recursive: true });
    try {
      await fsp.rename(staging, final);
    } catch (err: any) {
      // Another client committed the same content while this copy was running. Same key means
      // same hash means the same bytes, so theirs is as good as ours.
      if (err?.code === "ENOTEMPTY" || err?.code === "EEXIST" || err?.code === "EPERM") {
        const theirs = await readPayloadManifest(storeDir, key);
        if (theirs?.hash === hash) {
          await fsp.rm(staging, { recursive: true, force: true });
          return { success: true, key, manifest: theirs, reused: true, bytesCopied, message: `"${meta.name}" was already stored.` };
        }
      }
      throw err;
    }

    return {
      success: true,
      key,
      manifest,
      reused: false,
      bytesCopied,
      message: `Stored "${meta.name}" (${formatBytes(bytesTotal)}).`
    };
  } catch (err: any) {
    return { success: false, message: `Couldn't store "${meta.name}": ${err?.message ?? err}` };
  }
}

async function hashExistingFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const read = fs.createReadStream(file);
    read.on("error", reject);
    read.on("data", (chunk) => hash.update(chunk));
    read.on("end", () => resolve());
  });
  return hash.digest("hex");
}

/* --------------------------------------------------------------------------
 * Verifying
 * ----------------------------------------------------------------------- */

export interface VerifyResult {
  ok: boolean;
  key: string;
  /** "deep" re-hashed every byte; "shallow" only checked the file count and sizes. */
  depth: "shallow" | "deep";
  message: string;
  expectedHash?: string;
  actualHash?: string;
}

/**
 * Checks a payload is what its manifest says.
 *
 * Shallow by default — file count and total bytes — because that is instant and catches the
 * failure that actually happens: a copy that died partway. `deep` re-hashes everything and is
 * the only way to catch silent corruption, but re-reading 4.76 GB is a deliberate choice the
 * user makes, not something done on the way past.
 */
export async function verifyPayload(storeDir: string, key: string, deep = false): Promise<VerifyResult> {
  const manifest = await readPayloadManifest(storeDir, key);
  if (!manifest) return { ok: false, key, depth: "shallow", message: "No payload manifest — nothing to trust." };

  const dir = payloadDir(storeDir, key);
  const found: PayloadFile[] = [];
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name === "payload.json") continue;
      addPath(path.join(dir, entry.name), entry.name, found);
    }
  } catch {
    return { ok: false, key, depth: "shallow", message: "The payload folder is missing." };
  }

  const bytes = found.reduce((s, f) => s + f.size, 0);
  if (found.length !== manifest.files || bytes !== manifest.bytes) {
    return {
      ok: false,
      key,
      depth: "shallow",
      message: `Incomplete: expected ${manifest.files} files (${formatBytes(manifest.bytes)}), found ${found.length} (${formatBytes(bytes)}).`
    };
  }

  if (!deep) {
    return { ok: true, key, depth: "shallow", message: `${manifest.files} files, ${formatBytes(manifest.bytes)}.` };
  }

  const hashes: { rel: string; hash: string }[] = [];
  for (const file of found) {
    hashes.push({ rel: toPosix(path.relative(dir, file.source)), hash: await hashExistingFile(file.source) });
  }
  const actual = combineHashes(hashes);
  return {
    ok: actual === manifest.hash,
    key,
    depth: "deep",
    expectedHash: manifest.hash,
    actualHash: actual,
    message: actual === manifest.hash ? "Contents match the recorded hash." : "Contents do NOT match the recorded hash."
  };
}

/* --------------------------------------------------------------------------
 * Copying out
 * ----------------------------------------------------------------------- */

export interface ApplyPayloadResult {
  success: boolean;
  message: string;
  filesCopied?: number;
  bytesCopied?: number;
}

/**
 * Installs a payload into an instance.
 *
 * The split-install rule is the whole reason this is not a plain directory copy: `user/…`
 * belongs to the SERVER root and `BepInEx/…` to the CLIENT root, and on a split install those
 * are different folders. Copying the payload wholesale to one root would put the server half
 * somewhere nothing ever reads it — the failure that looks exactly like success.
 *
 * `enabled: false` redirects into the `.disabled` folders, which is why payloads are stored
 * in the enabled layout and never twice.
 */
export async function applyPayload(
  storeDir: string,
  key: string,
  clientRoot: string,
  serverRoot: string,
  opts: { enabled?: boolean; verifyFirst?: boolean } = {}
): Promise<ApplyPayloadResult> {
  const enabled = opts.enabled !== false;

  if (opts.verifyFirst !== false) {
    // A payload that died halfway through a copy looks complete in a folder listing. Applying
    // it produces a mod with holes, which surfaces later as a crash nobody connects to this.
    const check = await verifyPayload(storeDir, key);
    if (!check.ok) return { success: false, message: `Not applied — ${check.message}` };
  }

  const dir = payloadDir(storeDir, key);
  const files: PayloadFile[] = [];
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name === "payload.json") continue;
      addPath(path.join(dir, entry.name), entry.name, files);
    }
  } catch {
    return { success: false, message: "That payload is not in the store." };
  }

  let filesCopied = 0;
  let bytesCopied = 0;
  try {
    for (const file of files) {
      const rel = toPosix(path.relative(dir, file.source));
      const target = resolvePayloadTarget(rel, clientRoot, serverRoot, enabled);
      if (!target) continue;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(file.source, target);
      filesCopied++;
      bytesCopied += file.size;
    }
  } catch (err: any) {
    return { success: false, message: `Couldn't install that mod: ${err?.message ?? err}` };
  }

  return {
    success: true,
    filesCopied,
    bytesCopied,
    message: `Installed ${filesCopied} file(s), ${formatBytes(bytesCopied)}.`
  };
}

/**
 * Maps a payload-relative path onto the right root, honouring split installs and the
 * enabled/disabled folder split.
 *
 * Returns null for anything that does not belong to a known SPT location, rather than
 * guessing — writing an unrecognised path into a game install is not a small mistake.
 */
export function resolvePayloadTarget(
  rel: string,
  clientRoot: string,
  serverRoot: string,
  enabled: boolean
): string | null {
  const parts = rel.split("/").filter(Boolean);
  const joinFrom = (root: string, replaceWith: string[], skip: number) =>
    path.join(root, ...replaceWith, ...parts.slice(skip));

  const lower = parts.map((s) => s.toLowerCase());

  if (lower[0] === "user" && lower[1] === "mods") {
    return joinFrom(serverRoot, enabled ? SERVER_MODS_DIR : SERVER_MODS_DISABLED_DIR, 2);
  }
  if (lower[0] === "bepinex" && lower[1] === "plugins") {
    return joinFrom(clientRoot, enabled ? CLIENT_PLUGINS_DIR : CLIENT_PLUGINS_DISABLED_DIR, 2);
  }
  if (lower[0] === "bepinex" && lower[1] === "patchers") {
    return joinFrom(clientRoot, enabled ? CLIENT_PATCHERS_DIR : CLIENT_PATCHERS_DISABLED_DIR, 2);
  }
  if (lower[0] === "bepinex" && lower[1] === "config") {
    // Config is never "disabled" — BepInEx reads it only when the plugin loads, and a config
    // left behind is what makes re-enabling a mod restore its settings.
    return joinFrom(clientRoot, ["BepInEx", "config"], 2);
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Housekeeping
 * ----------------------------------------------------------------------- */

export interface StoreUsage {
  payloads: number;
  bytes: number;
  /** Staging directories left by interrupted copies, and what they are holding. */
  stagingBytes: number;
}

export async function storeUsage(storeDir: string): Promise<StoreUsage> {
  const usage: StoreUsage = { payloads: 0, bytes: 0, stagingBytes: 0 };
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(payloadsDir(storeDir), { withFileTypes: true });
  } catch {
    return usage;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(payloadsDir(storeDir), entry.name);
    if (entry.name === ".staging") {
      const files: PayloadFile[] = [];
      addPath(dir, ".staging", files);
      usage.stagingBytes += files.reduce((s, f) => s + f.size, 0);
      continue;
    }
    const manifest = await readPayloadManifest(storeDir, entry.name);
    usage.payloads++;
    if (manifest) {
      usage.bytes += manifest.bytes;
    } else {
      const files: PayloadFile[] = [];
      addPath(dir, entry.name, files);
      usage.bytes += files.reduce((s, f) => s + f.size, 0);
    }
  }
  return usage;
}

/**
 * Deletes payloads no preset refers to any more.
 *
 * Deliberately takes the set of keys still in use rather than working it out, so the caller
 * has read every preset in the store first. Guessing here deletes multi-GB mods somebody
 * still needs.
 */
export async function collectOrphanPayloads(
  storeDir: string,
  keysInUse: Set<string>
): Promise<{ removed: string[]; bytesFreed: number; staleStaging: number }> {
  const removed: string[] = [];
  let bytesFreed = 0;
  let staleStaging = 0;

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(payloadsDir(storeDir), { withFileTypes: true });
  } catch {
    return { removed, bytesFreed, staleStaging };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (entry.name === ".staging") {
      // Staging holds resumable progress, so it is only cleared when the payload it was
      // building has since been committed by someone else.
      const staging = path.join(payloadsDir(storeDir), ".staging");
      for (const stale of await fsp.readdir(staging, { withFileTypes: true })) {
        if (!stale.isDirectory()) continue;
        if (await readPayloadManifest(storeDir, stale.name)) {
          await fsp.rm(path.join(staging, stale.name), { recursive: true, force: true });
          staleStaging++;
        }
      }
      continue;
    }

    if (keysInUse.has(entry.name)) continue;
    const manifest = await readPayloadManifest(storeDir, entry.name);
    bytesFreed += manifest?.bytes ?? 0;
    await fsp.rm(path.join(payloadsDir(storeDir), entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }

  return { removed, bytesFreed, staleStaging };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
