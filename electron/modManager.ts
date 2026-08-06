import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import Seven from "node-7z";
import { path7za } from "7zip-bin";
import { createExtractorFromFile } from "node-unrar-js";
import { ModInfo, ModType, RegistryEntry, ModListComparison } from "./types";

/**
 * Reads the SPT version from SPT_Data/Server/configs/core.json — the same file SPT's own
 * pipeline uses to validate compatibility, so it is a trustworthy source.
 * Best-effort: if the file is missing or the format changes in a future version, returns
 * undefined rather than breaking the rest of the app.
 */
// SPT's folder layout varies between versions and installation methods — sometimes there
// is a "Server" folder in the path, sometimes not; sometimes there is an extra folder
// with the same name as SPT (depending on how the release was extracted). Rather than
// guessing a fixed path (and continuing to get it wrong for installs unlike our own),
// this searches for the real core.json inside the instance — skipping heavy folders
// (user/mods, BepInEx, database) that don't contain it and would only slow the search
// down. The "database" folder is also home to a DIFFERENT core.json (for bots), which is
// not the one we want.
function findCoreJson(sptPath: string): any | undefined {
  const IGNORED_DIRS = new Set(["user", "bepinex", "database", "node_modules", ".git"]);
  const MAX_DEPTH = 5;

  function tryReadCore(corePath: string): any | undefined {
    try {
      return JSON.parse(fs.readFileSync(corePath, "utf-8"));
    } catch {
      return undefined;
    }
  }

  function search(dir: string, depth: number): any | undefined {
    if (depth > MAX_DEPTH) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === "core.json") {
        const result = tryReadCore(path.join(dir, entry.name));
        if (result) return result;
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name.toLowerCase())) {
        const result = search(path.join(dir, entry.name), depth + 1);
        if (result) return result;
      }
    }
    return undefined;
  }

  return search(sptPath, 0);
}

export function detectSptVersion(sptPath: string): string | undefined {
  const core = findCoreJson(sptPath);
  if (!core) return undefined;
  if (typeof core.sptVersion === "string") return `SPT ${core.sptVersion}`;
  if (typeof core.akiVersion === "string") return `SPT ${core.akiVersion}`;
  // From SPT 4.0 on, core.json no longer stores the SPT version itself — only the Tarkov
  // version it is compatible with. That is not the same information, but it is the best
  // hint this file offers, so label it correctly rather than passing it off as the SPT
  // version.
  if (typeof core.compatibleTarkovVersion === "string") return `Tarkov ${core.compatibleTarkovVersion}`;
  return undefined;
}

// "Raw" version (no label, no fallback to the Tarkov version) — for functional use, such
// as sending to the Forge API, which expects a real semver (e.g. "3.11.5") and would not
// understand "Tarkov 0.16.9.40087". On SPT 4.0+ installs that no longer expose the field
// this deliberately returns undefined — better to ask the user than to send Forge
// something wrong.
export function detectSptSemver(sptPath: string): string | undefined {
  const core = findCoreJson(sptPath);
  if (!core) return undefined;
  if (typeof core.sptVersion === "string") return core.sptVersion;
  if (typeof core.akiVersion === "string") return core.akiVersion;
  return undefined;
}

/**
 * Extracts a .zip, .7z, or .rar into a destination folder.
 * .zip uses adm-zip (pure JS, no external binary).
 * .7z uses the 7za binary bundled via 7zip-bin, driven by node-7z.
 * .rar uses node-unrar-js (WASM build of the official unrar library, no external binary).
 */
// Detects an archive entry trying to escape the destination folder ("zip slip") — e.g. an
// entry named "../../../Windows/System32/evil.dll", or an absolute path like
// "C:\Windows\evil.dll". Backslashes are normalised to forward slashes before checking so
// both path styles are caught regardless of which OS produced the archive.
function isDangerousEntryPath(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split("/").some((segment) => segment === "..");
}

/**
 * Checks an archive's entry list BEFORE extracting anything — never after.
 * A malicious mod (or a corrupted/tampered archive) could in principle try to write
 * outside the temporary extraction folder. .zip is already protected by the library
 * itself (AdmZip normalises and clamps every path inside the destination). For .7z and
 * .rar, which have no such confirmed built-in guarantee, we list the entries without
 * extracting and reject the whole archive if any looks suspicious — better to refuse
 * outright than to extract partially or try to "fix" filenames ourselves.
 */
async function validateArchiveEntries(archivePath: string): Promise<void> {
  const ext = path.extname(archivePath).toLowerCase();

  // A large .zip is extracted by 7za (see extractArchive), so it loses AdmZip's
  // sanitisation — it needs the same entry validation as a .7z.
  const zipHandledBySevenZip =
    ext === ".zip" && fs.existsSync(archivePath) && fs.statSync(archivePath).size >= LARGE_ARCHIVE_THRESHOLD_BYTES;

  if (ext === ".7z" || zipHandledBySevenZip) {
    const entries: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = Seven.list(archivePath, { $bin: resolveUnpackedBinaryPath(path7za) });
      stream.on("data", (data: any) => {
        if (data?.file) entries.push(data.file);
      });
      stream.on("end", () => resolve());
      stream.on("error", (err: Error) => reject(err));
    });
    const dangerous = entries.find(isDangerousEntryPath);
    if (dangerous) {
      throw new Error(`File rejected for security reasons: suspicious entry in the ${ext} ("${dangerous}").`);
    }
    return;
  }

  if (ext === ".rar") {
    const extractor = await createExtractorFromFile({ filepath: archivePath });
    const { fileHeaders } = extractor.getFileList();
    for (const header of fileHeaders) {
      if (isDangerousEntryPath(header.name)) {
        throw new Error(`File rejected for security reasons: suspicious entry in the .rar ("${header.name}").`);
      }
    }
    return;
  }

  // .zip: AdmZip itself already sanitises every path against the destination before
  // writing (confirmed in the installed version) — no extra check needed here.
}

// Above this, AdmZip cannot cope (Node's 2 GiB buffer limit); the margin keeps us clear
// of the ceiling given internal overhead.
const LARGE_ARCHIVE_THRESHOLD_BYTES = 1_500_000_000;

function extractWithSevenZip(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = Seven.extractFull(archivePath, destDir, { $bin: resolveUnpackedBinaryPath(path7za) });
    stream.on("end", () => resolve());
    stream.on("error", (err: Error) => reject(err));
  });
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const ext = path.extname(archivePath).toLowerCase();
  await validateArchiveEntries(archivePath);

  if (ext === ".zip") {
    // AdmZip loads the whole archive into memory (readFileSync), and Node refuses
    // buffers above 2 GiB — content mods exceed that comfortably. Above the threshold we
    // use 7za, which also opens .zip and works in streaming mode.
    if (fs.statSync(archivePath).size >= LARGE_ARCHIVE_THRESHOLD_BYTES) {
      return extractWithSevenZip(archivePath, destDir);
    }
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(destDir, true);
    return;
  }

  if (ext === ".7z") {
    return extractWithSevenZip(archivePath, destDir);
  }

  if (ext === ".rar") {
    const extractor = await createExtractorFromFile({ filepath: archivePath, targetPath: destDir });
    // Extraction is lazy (a generator) — it must be iterated to actually write files to disk.
    const { files } = extractor.extract();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _file of files) {
      // iterating purely to force each entry to be extracted
    }
    return;
  }

  throw new Error(`Unsupported archive format: ${ext}. Use .zip, .7z, or .rar.`);
}

/**
 * When packaged, the app runs from inside an .asar archive — but a binary (.exe) cannot
 * be executed from inside the asar, because it does not exist there as a real file on
 * disk (it is only a virtual entry inside the packaged archive). electron-builder is
 * configured (via "asarUnpack" in package.json) to copy 7za.exe outside the asar into a
 * sibling "app.asar.unpacked" folder — except the 7zip-bin package computes the binary's
 * path relative to its own __dirname, which still points inside the .asar. This function
 * corrects that at spawn time. In dev mode (no asar) the path contains no ".asar" and the
 * function is a no-op.
 */
function resolveUnpackedBinaryPath(binPath: string): string {
  const asarSegment = `.asar${path.sep}`;
  if (binPath.includes(asarSegment)) {
    return binPath.replace(asarSegment, `.asar.unpacked${path.sep}`);
  }
  return binPath;
}

// --- Folders of interest inside an SPT instance ---
const SERVER_MODS_DIR = ["user", "mods"];
const SERVER_MODS_DISABLED_DIR = ["user", "mods.disabled"];
const CLIENT_PLUGINS_DIR = ["BepInEx", "plugins"];
const CLIENT_PLUGINS_DISABLED_DIR = ["BepInEx", "plugins.disabled"];
// Prepatchers run BEFORE the game loads and live outside plugins/. A mod can ship both
// parts (e.g. Wedge has Wedge.Client.dll in plugins/ and Wedge.Prepatch.dll in patchers/),
// and disabling only the plugin left the patcher active — worse than not disabling at
// all, because the mod ends up half-loaded.
const CLIENT_PATCHERS_DIR = ["BepInEx", "patchers"];
const CLIENT_PATCHERS_DISABLED_DIR = ["BepInEx", "patchers.disabled"];

/**
 * Files/folders that belong to SPT itself (not mods) but live inside BepInEx/plugins —
 * the same directory client mods use. The Manager's scanner must NEVER list, toggle, or
 * remove these entries, not even when the user selects "everything" and hits remove:
 * doing so breaks the entire SPT installation (which is exactly what happened when
 * "spt/spt-core.dll" was removed). If SPT ever renames these files, the right move is to
 * widen this list — err on the side of not touching things.
 */
const PROTECTED_CLIENT_PLUGIN_NAMES = new Set(["spt", "spt-core.dll"]);

/**
 * Many client mods install as "plugins/Mod.dll" + "plugins/Mod/" (the folder holding
 * config, assets, and so on). That folder is not a mod — it is the plugin's data. Without
 * this, it showed up as a second entry with the same name and no metadata at all,
 * cluttering both the list and the exported modlist.
 */
function listCompanionFolderNames(dir: string): Set<string> {
  if (!fs.existsSync(dir)) return new Set();
  const looseDllBases = new Set<string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
      looseDllBases.add(entry.name.slice(0, -4).toLowerCase());
    }
  }
  return looseDllBases;
}

/**
 * Files in BepInEx/patchers that belong to a client mod.
 *
 * Two sources, in this order:
 *  1. the manifest — when the app installed the mod, we know exactly which files came
 *     with it;
 *  2. the name — for mods installed outside the app, a patcher is usually called
 *     "<ModName>.Prepatch.dll", "<ModName>.Patcher.dll", or just "<ModName>.dll".
 *
 * The name rule requires a word boundary: "Wedge" matches "Wedge.Prepatch.dll" but NOT
 * "WedgeExtras.dll" — moving another mod's patcher would break that other mod.
 */
function findRelatedPatcherFiles(dir: string, modId: string, manifestFiles: string[] = []): string[] {
  if (!fs.existsSync(dir)) return [];
  const modBase = modId.replace(/\.dll$/i, "").toLowerCase();
  if (!modBase) return [];

  const fromManifest = new Set(
    manifestFiles
      .filter((f) => f.toLowerCase().includes("bepinex/patchers/"))
      .map((f) => path.basename(f).toLowerCase())
  );

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => {
      const lower = entry.name.toLowerCase();
      if (fromManifest.has(lower)) return true;
      const base = lower.replace(/\.dll$/i, "");
      if (base === modBase) return true;
      // word boundary: the character right after the mod name must not be alphanumeric
      return base.startsWith(modBase) && !/[a-z0-9]/.test(base.charAt(modBase.length));
    })
    .map((entry) => path.join(dir, entry.name));
}

function isProtectedClientEntry(name: string): boolean {
  return PROTECTED_CLIENT_PLUGIN_NAMES.has(name.toLowerCase());
}

/**
 * A relative path (inside the mod's archive) that would land on top of SPT's client core
 * — "BepInEx/plugins/spt/..." or "BepInEx/plugins/spt-core.dll".
 *
 * Some mods package SPT's entire tree alongside their own files, including a (usually
 * older) copy of these. Without this check, installing such a mod overwrote the user's
 * core and the game started reporting
 * "spt-core.dll file version doesn't match what was expected".
 *
 * This is distinct from the protection that already existed: that one prevents LISTING
 * and REMOVING the core; this one prevents OVERWRITING it during installation.
 */
function isProtectedInstancePath(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  const pluginsAt = parts.findIndex((seg, i) => seg === "plugins" && parts[i - 1] === "bepinex");
  if (pluginsAt === -1) return false;
  const next = parts[pluginsAt + 1];
  return next !== undefined && PROTECTED_CLIENT_PLUGIN_NAMES.has(next);
}

function p(sptPath: string, parts: string[]): string {
  return path.join(sptPath, ...parts);
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Reads version/author from the mod's package.json, when present. Best-effort: client
 * mods (BepInEx) rarely have one, so this returns empty without erroring in those cases.
 */
/* --------------------------------------------------------------------------
 * Reading mod metadata.
 *
 * SPT 3.x mods shipped a package.json with name/version/author. In SPT 4.0 mods became
 * .NET assemblies and that information moved INSIDE the DLL, into the mod's metadata
 * class (ModMetadata / BepInPlugin), stored as UTF-16 strings in the assembly:
 *
 *   "com.toha3673.unbreakablekeys"  <- GUID
 *   "Unbreakable Keys"              <- name
 *   "Toha3673"                      <- author
 *   "2.0.0"                         <- mod version
 *   "~4.0.0"                        <- supported SPT version
 *
 * Important: the PE's AssemblyVersion/FileVersion CANNOT be used here. In a real mod that
 * was checked, the assembly claimed 0.0.1.0 while the published version was 2.0.0 — the
 * author simply does not version the assembly. The value that counts is the one declared
 * in the metadata class.
 * ------------------------------------------------------------------------ */

export interface ForgeInstallInfo {
  name?: string;
  author?: string;
  version?: string;
  guid?: string;
}

export interface DllModMetadata {
  guid?: string;
  name?: string;
  author?: string;
  version?: string;
  sptVersion?: string;
}

const DLL_VERSION_RE = /^\d+\.\d+(\.\d+)?(\.\d+)?$/;
const DLL_CONSTRAINT_RE = /^[~^>=<]/;
const DLL_GUID_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,4}$/i;

// Extracts printable UTF-16LE strings — this is how .NET stores code literals in the #US
// heap, and where the mod's metadata ends up.
function extractUtf16Strings(buffer: Buffer, minLen = 3, maxLen = 120): string[] {
  const out: string[] = [];
  let current: number[] = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const lo = buffer[i];
    const printable = buffer[i + 1] === 0 && lo >= 0x20 && lo <= 0x7e;
    if (printable) {
      current.push(lo);
      if (current.length > maxLen) current = [];
    } else {
      if (current.length >= minLen) out.push(Buffer.from(current).toString("latin1"));
      current = [];
    }
  }
  if (current.length >= minLen) out.push(Buffer.from(current).toString("latin1"));
  return out;
}

const DLL_LICENSE_RE = /^(MIT|ISC|Apache|GPL|LGPL|AGPL|BSD|MPL|Unlicense|CC0|WTFPL|Zlib|Proprietary)[-\s0-9.]*$/i;

// Extracts ASCII/UTF-8 strings — where attribute arguments live (the #Blob heap), used by
// the BepInPlugin attribute on client mods.
function extractAsciiStrings(buffer: Buffer, minLen = 3, maxLen = 120): string[] {
  const out: string[] = [];
  let current: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 0x20 && byte <= 0x7e) {
      current.push(byte);
      if (current.length > maxLen) current = [];
    } else {
      if (current.length >= minLen) out.push(Buffer.from(current).toString("latin1"));
      current = [];
    }
  }
  if (current.length >= minLen) out.push(Buffer.from(current).toString("latin1"));
  return out;
}

function looksLikeModGuid(value: string): boolean {
  if (!DLL_GUID_RE.test(value)) return false;
  if (/^(system|microsoft|mscorlib|netstandard|newtonsoft|unityengine|bepinex|comfort|eft)\./i.test(value)) return false;
  if (/\.(dll|exe|json|jsonc|md|txt|cs|pdb|png|cfg)$/i.test(value)) return false;
  return true;
}

// A plausible mod name — rejects neighbouring strings that clearly are NOT a name (a log
// message, a VS_VERSION_INFO field, a path, a sentence).
function looksLikeModName(value: string): boolean {
  if (!value || value.length > 60) return false;
  if (/[[\]{}<>:;/\\|=]/.test(value)) return false;
  if (value.trim().split(/\s+/).length > 6) return false;
  if (/\.(dll|exe|json|jsonc|md|txt|cs|pdb|png|cfg)$/i.test(value)) return false;
  if (/^(InternalName|ProductName|FileDescription|CompanyName|OriginalFilename|LegalCopyright|FileVersion|ProductVersion|Assembly Version|Translation|VarFileInfo|StringFileInfo|VS_VERSION_INFO|ModMetadata|AllowMultiple)$/i.test(value)) return false;
  return /[a-zA-Z]/.test(value);
}

/**
 * Server mod (SPT 4.0): the values sit as UTF-16 literals right after the "ModMetadata"
 * marker. THE FIELD ORDER VARIES from mod to mod, because it depends on how the author
 * wrote the initialiser — verified across two mods by the same author:
 *
 *   bosseshavelegamedals: ModMetadata, " { ", GUID, name, author, version, ~spt, MIT
 *   brightlasers:         ModMetadata, " { ", name, author, version, ~spt, MIT, GUID
 *
 * So reading by fixed offset from the GUID does NOT work (that is what left half the mods
 * blank). We anchor on the "ModMetadata" marker and classify each string by SHAPE; the
 * leftover text is name and author, in that order (consistent across the mods checked).
 */
function parseServerModMetadata(utf16: string[]): DllModMetadata | null {
  const anchor = utf16.findIndex((v) => v === "ModMetadata");
  if (anchor === -1) return null;
  const window = utf16.slice(anchor + 1, anchor + 10);

  const guid = window.find(looksLikeModGuid);
  const version = window.find((v) => DLL_VERSION_RE.test(v));
  const sptVersion = window.find((v) => DLL_CONSTRAINT_RE.test(v) && /\d/.test(v));
  const textual = window.filter(
    (v) =>
      // Excludes ANY GUID-shaped string, not just the chosen one — mods that declare a
      // dependency have more than one, and the second was being treated as "author".
      !looksLikeModGuid(v) &&
      !DLL_VERSION_RE.test(v) &&
      !DLL_CONSTRAINT_RE.test(v) &&
      !DLL_LICENSE_RE.test(v) &&
      !/^https?:/i.test(v) &&
      looksLikeModName(v)
  );
  if (!guid && !version) return null;
  return { guid, name: textual[0], author: textual[1], version, sptVersion };
}

/**
 * Client mod (BepInEx): [BepInPlugin(GUID, Name, Version)]. Attribute arguments are
 * compile-time constants stored in the #Blob heap as UTF-8 — NOT UTF-16 — which is why
 * reading only UTF-16 found nothing in these mods. The three values sit adjacent to each
 * other, and the GUID is lowercase by convention (which distinguishes it from the
 * assembly's own PascalCase namespaces, e.g. "DrakiaXYZ.BigBrain").
 * This format has no author field — we leave it empty rather than inventing one.
 */
function parseClientModMetadata(ascii: string[]): DllModMetadata | null {
  // Collects ALL plausible (guid, name, version) blocks and keeps the one with the most
  // "qualified" GUID (the most reverse-domain segments).
  //
  // Requiring 3+ segments, as before, served to skip a decoy block some assemblies carry
  // ahead of the real one — but it discarded legitimate two-segment GUIDs
  // ("Kat.BetterAmmoLoadingList", "Tosox.DynamicItemWeights"), leaving those mods with no
  // version at all in the list. Picking the most qualified solves both: in IcyClawz the
  // decoy has 2 segments and the real one has 3, so the real one wins.
  const candidates: { meta: DllModMetadata; segments: number }[] = [];
  for (let i = 0; i < ascii.length - 2; i++) {
    const value = ascii[i];
    if (!looksLikeModGuid(value)) continue;
    const name = ascii[i + 1];
    const version = ascii[i + 2];
    if (!looksLikeModName(name) || !DLL_VERSION_RE.test(version)) continue;
    candidates.push({ meta: { guid: value, name, version }, segments: value.split(".").length });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.segments - a.segments);
  return candidates[0].meta;
}

export function parseModMetadataFromStrings(utf16: string[], ascii: string[] = []): DllModMetadata {
  return parseServerModMetadata(utf16) ?? parseClientModMetadata(ascii) ?? {};
}

export function readDllModMetadata(dllPath: string): DllModMetadata {
  try {
    const buffer = fs.readFileSync(dllPath);
    if (buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return {}; // not a PE ("MZ")
    return parseModMetadataFromStrings(extractUtf16Strings(buffer), extractAsciiStrings(buffer));
  } catch {
    return {};
  }
}

function readModMetadata(modPath: string): {
  version?: string;
  author?: string;
  guid?: string;
  declaredName?: string;
  sptVersion?: string;
} {
  try {
    if (!fs.existsSync(modPath)) return {};

    // A client mod can be a loose .dll with no folder of its own.
    if (!fs.statSync(modPath).isDirectory()) {
      if (modPath.toLowerCase().endsWith(".dll")) {
        const meta = readDllModMetadata(modPath);
        return { version: meta.version, author: meta.author, guid: meta.guid, declaredName: meta.name, sptVersion: meta.sptVersion };
      }
      return {};
    }

    // SPT 3.x: package.json still counts when it exists.
    const pkgPath = path.join(modPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
      if (typeof pkg.version === "string") {
        return { version: pkg.version, author, declaredName: typeof pkg.name === "string" ? pkg.name : undefined };
      }
    }

    // SPT 4.0: metadata lives inside the DLL.
    for (const dll of findFilesRecursive(modPath, ".dll")) {
      const meta = readDllModMetadata(dll);
      if (meta.version || meta.guid) {
        return { version: meta.version, author: meta.author, guid: meta.guid, declaredName: meta.name, sptVersion: meta.sptVersion };
      }
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Resolves the absolute path (folder or file) of an already-scanned mod, accounting for
 * whether it is enabled or disabled. Used by "Open folder" and other one-off actions.
 */
export function resolveModPath(
  clientRoot: string,
  serverRoot: string,
  mod: Pick<ModInfo, "id" | "type" | "enabled">
): string {
  const isServer = mod.type === "server";
  const base = isServer ? serverRoot : clientRoot;
  const dir = p(
    base,
    mod.enabled ? (isServer ? SERVER_MODS_DIR : CLIENT_PLUGINS_DIR) : isServer ? SERVER_MODS_DISABLED_DIR : CLIENT_PLUGINS_DISABLED_DIR
  );
  return path.join(dir, mod.id);
}
const SERVER_EXE_CANDIDATES = ["SPT.Server.exe", "Aki.Server.exe"];
const CLIENT_EXE_CANDIDATES = ["EscapeFromTarkov.exe"];

function hasClientMarkers(dir: string): boolean {
  return CLIENT_EXE_CANDIDATES.some((exe) => fs.existsSync(path.join(dir, exe))) || fs.existsSync(path.join(dir, "BepInEx"));
}

function hasServerMarkers(dir: string): boolean {
  return SERVER_EXE_CANDIDATES.some((exe) => fs.existsSync(path.join(dir, exe))) || fs.existsSync(path.join(dir, "user"));
}

export function validateSptPath(sptPath: string): { valid: boolean; reason?: string } {
  if (!fs.existsSync(sptPath)) {
    return { valid: false, reason: "Folder does not exist." };
  }
  if (!fs.statSync(sptPath).isDirectory()) {
    return { valid: false, reason: "The selected path is not a folder." };
  }

  const valid = hasClientMarkers(sptPath) || hasServerMarkers(sptPath);

  if (!valid) {
    return {
      valid: false,
      reason:
        "This does not look like a valid SPT instance. Expected to find SPT.Server.exe, EscapeFromTarkov.exe, or the user/ and BepInEx/ folders together."
    };
  }
  return { valid: true };
}

export interface SptInstancePaths {
  clientRoot: string; // where BepInEx/ and the game executable live
  serverRoot: string; // where SPT.Server.exe and user/ live — same as clientRoot in the vast majority of cases
  split: boolean; // true when client and server sit in different folders
}

/**
 * Works out where the client files (BepInEx/, game exe) and server files (SPT.Server.exe,
 * user/) live, starting from the folder the user picked. In most installations both sit
 * together in the same folder. But SPT 4.x's official installer can create a "split"
 * layout: the client in the chosen folder, and the server in a subfolder (usually also
 * called "SPT") one level down. If that is not handled separately, server mods
 * (user/mods/...) end up installed in the wrong place — the real server never sees them,
 * because it runs from inside the subfolder.
 */
export function resolveSptInstance(chosenPath: string): { instance: SptInstancePaths; autoDetected: boolean } | null {
  if (!fs.existsSync(chosenPath) || !fs.statSync(chosenPath).isDirectory()) return null;

  const chosenHasClient = hasClientMarkers(chosenPath);
  const chosenHasServer = hasServerMarkers(chosenPath);

  // Common case: everything is already in the chosen folder.
  if (chosenHasClient && chosenHasServer) {
    return { instance: { clientRoot: chosenPath, serverRoot: chosenPath, split: false }, autoDetected: false };
  }

  let clientRoot = chosenHasClient ? chosenPath : undefined;
  let serverRoot = chosenHasServer ? chosenPath : undefined;

  const subEntries = fs.readdirSync(chosenPath, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of subEntries) {
    const candidate = path.join(chosenPath, entry.name);
    if (!clientRoot && hasClientMarkers(candidate)) clientRoot = candidate;
    if (!serverRoot && hasServerMarkers(candidate)) serverRoot = candidate;
  }

  if (clientRoot && serverRoot) {
    const split = clientRoot !== serverRoot;
    const autoDetected = clientRoot !== chosenPath || serverRoot !== chosenPath;
    return { instance: { clientRoot, serverRoot, split }, autoDetected };
  }

  // Only one of the two was found (e.g. client only, if the server has never run) — use
  // the same path for both, preserving the previous behaviour for that case.
  const single = clientRoot || serverRoot;
  if (single) {
    return { instance: { clientRoot: single, serverRoot: single, split: false }, autoDetected: single !== chosenPath };
  }

  return null;
}

// --- Local registry of mods installed through the app (so we can tell them apart from "installed manually") ---
function getRegistryPath(sptPath: string): string {
  return path.join(sptPath, ".spt-mod-manager-registry.json");
}

function loadRegistry(sptPath: string): RegistryEntry[] {
  const regPath = getRegistryPath(sptPath);
  if (!fs.existsSync(regPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(regPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveRegistry(sptPath: string, entries: RegistryEntry[]) {
  fs.writeFileSync(getRegistryPath(sptPath), JSON.stringify(entries, null, 2), "utf-8");
}

function addToRegistry(sptPath: string, entry: RegistryEntry) {
  const reg = loadRegistry(sptPath);
  // An entry's identity is id + type, not id alone: one package can install a server part
  // and a client part with the SAME folder name (Wedge does this). Filtering by id alone
  // made the second one's registry entry erase the first's.
  const filtered = reg.filter((e) => !(e.id === entry.id && e.type === entry.type));
  filtered.push(entry);
  saveRegistry(sptPath, filtered);
}

function removeFromRegistry(sptPath: string, id: string, type?: ModType) {
  const reg = loadRegistry(sptPath);
  // Same reason as addToRegistry: without the type, removing Wedge's server part would
  // also erase the client part's registry entry, since they share an id.
  saveRegistry(
    sptPath,
    reg.filter((e) => !(e.id === id && (type === undefined || e.type === type)))
  );
}

// --- Aliases (nome de exibição customizado, não mexe em arquivo nenhum) ---
function getAliasesPath(sptPath: string): string {
  return path.join(sptPath, ".spt-mod-manager-aliases.json");
}

function loadAliases(sptPath: string): Record<string, string> {
  const aliasPath = getAliasesPath(sptPath);
  if (!fs.existsSync(aliasPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(aliasPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveAliases(sptPath: string, aliases: Record<string, string>) {
  fs.writeFileSync(getAliasesPath(sptPath), JSON.stringify(aliases, null, 2), "utf-8");
}

export function setModAlias(sptPath: string, modId: string, alias: string): { success: boolean; message: string } {
  const aliases = loadAliases(sptPath);
  const trimmed = alias.trim();
  if (trimmed.length === 0) {
    delete aliases[modId];
    saveAliases(sptPath, aliases);
    return { success: true, message: "Name restored to original." };
  }
  aliases[modId] = trimmed;
  saveAliases(sptPath, aliases);
  return { success: true, message: "Name updated." };
}

// --- Manifest of "orphan" files (hybrid mods installed via merge with no named folder) ---
// When a zip/7z/rar ships user/ and/or BepInEx/ but the files do not land in any
// recognisable folder (user/mods/<name> or BepInEx/plugins/<name>), we track each file
// that was written individually, so that "mod" at least shows up as a removable row in
// the list instead of becoming a ghost entry nobody can manage.
function getManifestPath(sptPath: string): string {
  return path.join(sptPath, ".spt-mod-manager-manifest.json");
}

function loadManifest(sptPath: string): Record<string, string[]> {
  const manifestPath = getManifestPath(sptPath);
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveManifest(sptPath: string, manifest: Record<string, string[]>) {
  fs.writeFileSync(getManifestPath(sptPath), JSON.stringify(manifest, null, 2), "utf-8");
}

function addManifestEntry(sptPath: string, id: string, relativeFiles: string[]) {
  const manifest = loadManifest(sptPath);
  manifest[id] = relativeFiles;
  saveManifest(sptPath, manifest);
}

function removeManifestEntry(sptPath: string, id: string) {
  const manifest = loadManifest(sptPath);
  delete manifest[id];
  saveManifest(sptPath, manifest);
}

/** Lists every file (recursively) under baseDir, with relative paths always using "/". */
function listFilesRelative(baseDir: string, currentDir: string = baseDir): string[] {
  let results: string[] = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(listFilesRelative(baseDir, full));
    } else {
      results.push(path.relative(baseDir, full).split(path.sep).join("/"));
    }
  }
  return results;
}

// --- Load order (server mods load alphabetically; we prefix with a number) ---
function stripLoadOrderPrefix(name: string): { order: number; cleanName: string } {
  const match = name.match(/^(\d{2})_(.+)$/);
  if (match) {
    return { order: parseInt(match[1], 10), cleanName: match[2] };
  }
  return { order: 99, cleanName: name };
}

// --- Scanning installed mods ---
/**
 * Builds the export payload for the current mod list — reuses scanMods, so it reflects
 * exactly what the UI shows (original name, type, status, version/author where present).
 */
export function exportModListData(clientRoot: string, serverRoot: string) {
  const mods = scanMods(clientRoot, serverRoot);
  return {
    exportedAt: new Date().toISOString(),
    mods: mods.map((m) => ({
      name: m.originalName,
      type: m.type,
      enabled: m.enabled,
      version: m.version,
      author: m.author,
      // The GUID is what lets the list be restored later by exact identifier, instead of
      // guessing from the folder name (which almost never matches the name on Forge).
      guid: m.guid
    }))
  };
}

/**
 * Compares an imported list of mod names (from an earlier export, yours or someone
 * else's) against what is installed now. Installs nothing automatically — we do not keep
 * the mods' original archives, so the honest thing is to show the difference and let you
 * decide what to reinstall.
 */
export function compareModList(clientRoot: string, serverRoot: string, importedNames: string[]): ModListComparison {
  const currentNames = scanMods(clientRoot, serverRoot).map((m) => m.originalName);
  const currentSet = new Set(currentNames);
  const importedSet = new Set(importedNames);
  return {
    missing: importedNames.filter((n) => !currentSet.has(n)),
    extra: currentNames.filter((n) => !importedSet.has(n))
  };
}

export interface ConflictReport {
  clientFileConflicts: { fileName: string; mods: string[] }[];
  duplicateServerNames: { declaredName: string; mods: string[] }[];
  duplicateClientMods?: { declaredName: string; mods: string[] }[];
}

/**
 * Best-effort conflict checking at the file level — this is not (and does not try to be) a
 * semantic analysis of "these two mods touch the same game item". What can be detected
 * safely from the filesystem:
 *
 * 1) DLLs with the same name coming from DIFFERENT client mods — BepInEx loads every DLL
 *    it finds recursively under BepInEx/plugins/, so two copies of the same dependency (or
 *    two same-named dlls from different mods) can collide at runtime.
 * 2) Server mods declaring the same "name" in package.json but sitting in different
 *    folders — the classic sign of "I installed the same mod twice without noticing"
 *    (e.g. it was updated and the old folder was never removed).
 */
/**
 * Compares the SPT version constraint declared by the mod against the instance's version.
 *
 * This is 100% LOCAL: the information comes from the mod's own DLL ("~4.0.0", "4.0.13",
 * "~4.0"), so it works without querying any API at all, and keeps working when the
 * network or Forge is unavailable.
 *
 * (The original note here claimed this mattered "now that Forge is going offline". That
 * has not happened — the Forge API is alive and is what the update check uses. The local
 * check is still worth having as an offline-capable fallback, which is why it stays.)
 *
 * Returns "unknown" when the mod declares nothing (3.x mods, or 4.0 mods that omit the
 * field): in that case nothing can be asserted, and asserting would be worse than silence.
 */
export function checkSptCompatibility(
  modConstraint: string | undefined,
  instanceVersion: string | undefined
): "compatible" | "incompatible" | "unknown" {
  if (!modConstraint?.trim() || !instanceVersion?.trim()) return "unknown";

  const parse = (v: string) =>
    v
      .trim()
      .replace(/^[~^>=<\s]+/, "")
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10))
      .filter((n) => !Number.isNaN(n));

  const wanted = parse(modConstraint);
  const actual = parse(instanceVersion);
  if (wanted.length === 0 || actual.length === 0) return "unknown";

  const operator = modConstraint.trim().startsWith("~")
    ? "tilde"
    : modConstraint.trim().startsWith("^")
      ? "caret"
      : modConstraint.trim().startsWith(">")
        ? "atLeast"
        : "exact";

  // "^4.0" accepts any 4.x; "~4.0.0" accepts any 4.0.x; ">=4.0" accepts that and above.
  if (operator === "atLeast") {
    for (let i = 0; i < Math.max(wanted.length, actual.length); i++) {
      const a = actual[i] ?? 0;
      const w = wanted[i] ?? 0;
      if (a !== w) return a > w ? "compatible" : "incompatible";
    }
    return "compatible";
  }

  const precision = operator === "caret" ? 1 : Math.min(wanted.length, operator === "tilde" ? 2 : wanted.length);
  for (let i = 0; i < precision; i++) {
    if ((actual[i] ?? 0) !== (wanted[i] ?? 0)) return "incompatible";
  }
  return "compatible";
}

export function detectConflicts(clientRoot: string, serverRoot: string): ConflictReport {
  const clientFileConflicts: { fileName: string; mods: string[] }[] = [];
  const dllOwners = new Map<string, Set<string>>();

  const clientDir = p(clientRoot, CLIENT_PLUGINS_DIR);
  if (fs.existsSync(clientDir)) {
    for (const entry of fs.readdirSync(clientDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const dlls = findFilesRecursive(path.join(clientDir, entry.name), ".dll");
        for (const dllPath of dlls) {
          const base = path.basename(dllPath);
          if (!dllOwners.has(base)) dllOwners.set(base, new Set());
          dllOwners.get(base)!.add(entry.name);
        }
      } else if (entry.name.toLowerCase().endsWith(".dll")) {
        if (!dllOwners.has(entry.name)) dllOwners.set(entry.name, new Set());
        dllOwners.get(entry.name)!.add("(loose in BepInEx/plugins)");
      }
    }
  }
  for (const [fileName, owners] of dllOwners) {
    if (owners.size > 1) clientFileConflicts.push({ fileName, mods: [...owners] });
  }

  const duplicateServerNames: { declaredName: string; mods: string[] }[] = [];
  const nameOwners = new Map<string, Set<string>>();
  const serverDir = p(serverRoot, SERVER_MODS_DIR);
  if (fs.existsSync(serverDir)) {
    for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Identifies the mod by its declared GUID (read from the DLL on SPT 4.0) and, absent
      // that, by the "name" in package.json (3.x mods).
      //
      // This previously looked only at package.json — which 4.0 mods no longer ship, since
      // the metadata moved inside the assembly. In other words, the check detected no
      // duplicates whatsoever on a 4.0 installation.
      const metadata = readModMetadata(path.join(serverDir, entry.name));
      const identity = metadata.guid ?? metadata.declaredName;
      if (!identity) continue;
      if (!nameOwners.has(identity)) nameOwners.set(identity, new Set());
      nameOwners.get(identity)!.add(entry.name);
    }
  }
  for (const [declaredName, owners] of nameOwners) {
    if (owners.size > 1) duplicateServerNames.push({ declaredName, mods: [...owners] });
  }

  // Duplicate CLIENT mod: the same mod installed in two different folders. Detected via
  // the BepInPlugin GUID — the folder name is useless here, since the whole point is that
  // the names differ ("SAIN" and "SAIN.4.4.3", for example).
  const duplicateClientMods: { declaredName: string; mods: string[] }[] = [];
  const clientGuidOwners = new Map<string, Set<string>>();
  if (fs.existsSync(clientDir)) {
    for (const entry of fs.readdirSync(clientDir, { withFileTypes: true })) {
      if (isProtectedClientEntry(entry.name)) continue;
      const meta = readModMetadata(path.join(clientDir, entry.name));
      if (!meta.guid) continue;
      if (!clientGuidOwners.has(meta.guid)) clientGuidOwners.set(meta.guid, new Set());
      clientGuidOwners.get(meta.guid)!.add(entry.name);
    }
  }
  for (const [guid, owners] of clientGuidOwners) {
    if (owners.size > 1) duplicateClientMods.push({ declaredName: guid, mods: [...owners] });
  }

  return { clientFileConflicts, duplicateServerNames, duplicateClientMods };
}

// Resolves the real path of a manifest-tracked file: anything starting with "user/"
// belongs to the server side (serverRoot); everything else (BepInEx/, or any loose file
// left at the mod's root) belongs to the client side (clientRoot). On non-split installs
// (the common case) clientRoot === serverRoot, so this changes nothing — it only matters
// when the two folders genuinely differ.
function resolveManifestFilePath(clientRoot: string, serverRoot: string, relPath: string): string {
  const base = relPath.toLowerCase().startsWith("user/") ? serverRoot : clientRoot;
  return path.join(base, relPath);
}

export function scanMods(clientRoot: string, serverRoot: string): ModInfo[] {
  const registry = loadRegistry(clientRoot);
  const registryIds = new Set(registry.map((r) => r.id));
  const aliases = loadAliases(clientRoot);
  const mods: ModInfo[] = [];

  // Resolves the display name of a "linked" mod (e.g. a loose file from the same install)
  // — used both to show a hint in the list and so the confirmation dialog before removal
  // can warn that the other one goes too.
  function resolveLinkedName(linkedModId: string | undefined): string | undefined {
    if (!linkedModId) return undefined;
    const linkedEntry = registry.find((r) => r.id === linkedModId);
    if (!linkedEntry) return undefined;
    return aliases[linkedModId] ?? linkedEntry.displayName;
  }

  function pushMod(id: string, cleanName: string, type: ModType, enabled: boolean, loadOrder: number, modPath?: string) {
    const metadata = modPath ? readModMetadata(modPath) : {};
    // Look up by id + type: with Wedge-server and Wedge-client both in the registry,
    // searching by id alone would return the wrong entry for one of the two rows.
    const registryEntry = registry.find((r) => r.id === id && r.type === type);
    mods.push({
      id,
      name: aliases[id] ?? cleanName,
      originalName: cleanName,
      type,
      enabled,
      installedManually: !registryIds.has(id),
      loadOrder,
      // Priority: whatever the mod declares locally; failing that, whatever Forge told us
      // when the app installed it (a trustworthy source — client mods, for instance, have
      // no author field in the DLL at all).
      version: metadata.version ?? registryEntry?.forgeVersion,
      author: metadata.author ?? registryEntry?.forgeAuthor,
      // The GUID Forge ITSELF gave us at install time comes first: it is Forge's own
      // identifier, and the one the API filters understand. The GUID read from the DLL
      // (BepInPlugin) belongs to the mod's runtime and is not always the same — it serves
      // as plan B for mods installed outside the app.
      guid: registryEntry?.forgeGuid ?? metadata.guid,
      sptVersion: metadata.sptVersion,
      packageId: registryEntry?.packageId,
      installedAt: registryEntry?.installedAt,
      linkedModName: resolveLinkedName(registryEntry?.linkedModId)
    });
  }

  // Server mods (enabled)
  const serverDir = p(serverRoot, SERVER_MODS_DIR);
  if (fs.existsSync(serverDir)) {
    for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const { order, cleanName } = stripLoadOrderPrefix(entry.name);
      pushMod(entry.name, cleanName, "server", true, order, path.join(serverDir, entry.name));
    }
  }

  // Server mods (disabled)
  const serverDisabledDir = p(serverRoot, SERVER_MODS_DISABLED_DIR);
  if (fs.existsSync(serverDisabledDir)) {
    for (const entry of fs.readdirSync(serverDisabledDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const { order, cleanName } = stripLoadOrderPrefix(entry.name);
      pushMod(entry.name, cleanName, "server", false, order, path.join(serverDisabledDir, entry.name));
    }
  }

  // Client mods (enabled) — loose plugins (.dll) or ones in subfolders
  const clientDir = p(clientRoot, CLIENT_PLUGINS_DIR);
  if (fs.existsSync(clientDir)) {
    const companions = listCompanionFolderNames(clientDir);
    for (const entry of fs.readdirSync(clientDir, { withFileTypes: true })) {
      if (isProtectedClientEntry(entry.name)) continue; // SPT's own core — never a mod
      // data folder belonging to a loose .dll of the same name: part of it, not a separate mod
      if (entry.isDirectory() && companions.has(entry.name.toLowerCase())) continue;
      if (entry.name.endsWith(".dll") || entry.isDirectory()) {
        pushMod(entry.name, entry.name.replace(/\.dll$/i, ""), "client", true, 0, path.join(clientDir, entry.name));
      }
    }
  }

  // Client mods (desabilitados)
  const clientDisabledDir = p(clientRoot, CLIENT_PLUGINS_DISABLED_DIR);
  if (fs.existsSync(clientDisabledDir)) {
    const companions = listCompanionFolderNames(clientDisabledDir);
    for (const entry of fs.readdirSync(clientDisabledDir, { withFileTypes: true })) {
      if (isProtectedClientEntry(entry.name)) continue; // SPT's own core — never a mod
      // data folder belonging to a loose .dll of the same name: part of it, not a separate mod
      if (entry.isDirectory() && companions.has(entry.name.toLowerCase())) continue;
      if (entry.name.endsWith(".dll") || entry.isDirectory()) {
        pushMod(entry.name, entry.name.replace(/\.dll$/i, ""), "client", false, 0, path.join(clientDisabledDir, entry.name));
      }
    }
  }

  // Mods "órfãos" rastreados por manifesto (arquivos sem pasta nomeada própria) — não suportam
  // habilitar/desabilitar, mas aparecem na lista e podem ser removidos de forma limpa.
  const manifest = loadManifest(clientRoot);
  // Ids dos mods "de verdade" (com pasta própria) já listados acima.
  const namedModIds = new Set(mods.map((m) => m.id));
  for (const [manifestId, files] of Object.entries(manifest)) {
    const stillExists = files.some((relPath) => fs.existsSync(resolveManifestFilePath(clientRoot, serverRoot, relPath)));
    if (!stillExists) continue; // arquivos já não existem mais (removidos por fora) — não mostra fantasma
    const registryEntry = registry.find((r) => r.id === manifestId);

    // Quando esses arquivos soltos vieram do mesmo arquivo de um único mod nomeado,
    // não são um item separado do ponto de vista de quem usa — são parte daquele mod.
    // Some da lista (evita a linha duplicada tipo "DynamicMaps" + "DynamicMaps-1.1.3")
    // e a remoção do mod leva esses arquivos junto (ver uninstallMod).
    // Se o mod ligado não existir mais, o órfão VOLTA a aparecer — senão viraria
    // arquivo invisível e impossível de remover pelo app.
    const linkedTo = registryEntry?.linkedModIds ?? (registryEntry?.linkedModId ? [registryEntry.linkedModId] : []);
    if (linkedTo.length > 0 && linkedTo.some((id) => namedModIds.has(id))) continue;

    // Vínculo implícito: órfão com o mesmo nome de exibição de um mod que existe é,
    // na prática, sobra daquele mod. Cobre instalações feitas antes do vínculo
    // explícito existir — sem isso, elas ficam duplicando a linha do mod pra sempre.
    const displayName = registryEntry?.displayName;
    if (displayName && namedModIds.has(displayName)) continue;

    // O nome do órfão costuma vir do arquivo baixado, com versão colada
    // ("MergeConsumables.1.5.4"), enquanto o mod se chama "MergeConsumables". Comparar
    // as formas limpas liga os dois e tira a linha duplicada da lista.
    if (displayName) {
      const cleanedVariants = stripFolderNameNoise(displayName).map((v) => v.toLowerCase());
      const namedLower = new Map([...namedModIds].map((id) => [id.toLowerCase(), id]));
      if (cleanedVariants.some((v) => namedLower.has(v))) continue;
    }

    mods.push({
      id: manifestId,
      name: aliases[manifestId] ?? registryEntry?.displayName ?? manifestId,
      originalName: registryEntry?.displayName ?? manifestId,
      type: registryEntry?.type ?? "hybrid",
      enabled: true,
      installedManually: false,
      loadOrder: 99,
      installedAt: registryEntry?.installedAt,
      manifestOnly: true,
      linkedModName: resolveLinkedName(registryEntry?.linkedModId)
    });
  }

  // Pacote INFERIDO, pra mods que já estavam instalados antes do vínculo existir.
  //
  // Sinal: a mesma pasta aparecendo dos dois lados (user/mods/Wedge + BepInEx/plugins/Wedge).
  // Autor de mod nomeia a pasta com o nome do mod, então dois mods DIFERENTES com nome de
  // pasta idêntico é bem improvável — conferido numa instalação real de 136 mods, onde os
  // 8 pares nessa situação eram todos o mesmo mod.
  //
  // O id começa com "inferred:" de propósito: é palpite, não registro, então não é gravado
  // em disco e some se a pasta for renomeada. Se errar, desfazer é só alternar de novo.
  // A chave ignora separadores e o sufixo que indica O PAPEL da parte, não o mod:
  // "MoreBotsServer" + "MoreBotsAPI" -> "morebots"; "MergeConsumablesServer" +
  // "MergeConsumables" -> "mergeconsumables". Conferido contra 9 pares reais de uma
  // instalação de verdade — todos agruparam, e pares que NÃO são o mesmo mod
  // ("WTT-ServerCommonLib" e "WTT-ClientCommonLib") continuaram separados, porque o
  // sufixo removido é só o do fim.
  const packageBaseKey = (folderName: string): string => {
    let key = folderName.toLowerCase().replace(/[-._\s]/g, "");
    for (const suffix of ["serverside", "clientside", "backend", "server", "client", "api"]) {
      if (key.endsWith(suffix) && key.length > suffix.length + 2) {
        key = key.slice(0, -suffix.length);
        break;
      }
    }
    return key;
  };

  const byFolderName = new Map<string, ModInfo[]>();
  for (const mod of mods) {
    if (mod.packageId || mod.manifestOnly) continue;
    const key = packageBaseKey(mod.id);
    if (!key) continue;
    if (!byFolderName.has(key)) byFolderName.set(key, []);
    byFolderName.get(key)!.push(mod);
  }
  for (const [key, group] of byFolderName) {
    const tiposDistintos = new Set(group.map((m) => m.type));
    if (group.length >= 2 && tiposDistintos.size >= 2) {
      for (const mod of group) {
        mod.packageId = `inferred:${key}`;
        // Guarda quem são as outras partes: os nomes podem diferir, então o toggle não
        // tem como redescobrir isso sozinho.
        mod.packageSiblings = group
          .filter((other) => !(other.id === mod.id && other.type === mod.type))
          .map((other) => ({ id: other.id, type: other.type }));
      }
    }
  }

  return mods.sort((a, b) => a.loadOrder - b.loadOrder || a.name.localeCompare(b.name));
}

// --- Instalar mod a partir de um .zip ou .7z ---
export interface InstallResult {
  success: boolean;
  message: string;
  needsConfirmation?: boolean;
  tmpDir?: string;
  rootEntries?: string[];
  archivePath?: string;
}

export async function installModFromArchive(
  clientRoot: string,
  serverRoot: string,
  archivePath: string,
  preferredDisplayName?: string,
  forgeInfo?: ForgeInstallInfo
): Promise<InstallResult> {
  const tmpExtractDir = path.join(clientRoot, ".tmp-mod-extract-" + Date.now());
  try {
    ensureDir(tmpExtractDir);
    await extractArchive(archivePath, tmpExtractDir);

    const mergeRoot = findMergeRoot(tmpExtractDir);

    if (mergeRoot) {
      return performMerge(clientRoot, serverRoot, mergeRoot, archivePath, tmpExtractDir, preferredDisplayName, forgeInfo);
    }

    // Caso 2: zip contém DLLs soltas ou uma única pasta -> tentar identificar client vs server
    const dllFiles = findFilesRecursive(tmpExtractDir, ".dll");
    const hasPackageJson = findFilesRecursive(tmpExtractDir, "package.json").length > 0;

    let destBase: string;
    let modId: string;
    let type: ModType;

    if (hasPackageJson && dllFiles.length === 0) {
      // Server mod: assume que a raiz extraída (ou sua única subpasta) é a pasta do mod
      const rootEntries = fs.readdirSync(tmpExtractDir, { withFileTypes: true });
      const singleDir = rootEntries.length === 1 && rootEntries[0].isDirectory() ? rootEntries[0].name : null;
      const sourceDir = singleDir ? path.join(tmpExtractDir, singleDir) : tmpExtractDir;
      modId = singleDir ?? path.parse(archivePath).name;
      destBase = p(serverRoot, SERVER_MODS_DIR);
      ensureDir(destBase);
      const serverDest = path.join(destBase, modId);
      copyRecursive(sourceDir, serverDest);
      const verification = verifyCopyRecursive(sourceDir, serverDest);
      if (!verification.ok) {
        cleanup(tmpExtractDir);
        return { success: false, message: `Instalação incompleta: arquivo não confirmado no destino (${verification.missing}).` };
      }
      type = "server";
    } else if (dllFiles.length > 0) {
      // Client mod: copia pasta (ou soltas) pra BepInEx/plugins
      destBase = p(clientRoot, CLIENT_PLUGINS_DIR);
      ensureDir(destBase);
      const rootEntries = fs.readdirSync(tmpExtractDir, { withFileTypes: true });
      const singleDir = rootEntries.length === 1 && rootEntries[0].isDirectory() ? rootEntries[0].name : null;
      if (singleDir) {
        modId = singleDir;
        const clientDest = path.join(destBase, singleDir);
        copyRecursive(path.join(tmpExtractDir, singleDir), clientDest);
        const verification = verifyCopyRecursive(path.join(tmpExtractDir, singleDir), clientDest);
        if (!verification.ok) {
          cleanup(tmpExtractDir);
          return { success: false, message: `Instalação incompleta: arquivo não confirmado no destino (${verification.missing}).` };
        }
      } else {
        modId = path.parse(archivePath).name;
        const clientDest = path.join(destBase, modId);
        copyRecursive(tmpExtractDir, clientDest);
        const verification = verifyCopyRecursive(tmpExtractDir, clientDest);
        if (!verification.ok) {
          cleanup(tmpExtractDir);
          return { success: false, message: `Instalação incompleta: arquivo não confirmado no destino (${verification.missing}).` };
        }
      }
      type = "client";
    } else {
      // Estrutura não reconhecida (sem DLL, sem package.json, sem pasta user/BepInEx em
      // nenhum nível). Em vez de rejeitar de cara, devolve o conteúdo da raiz pro usuário
      // decidir — NÃO limpa a pasta temporária aqui, pra reaproveitar a mesma extração se
      // ele escolher continuar, em vez de precisar selecionar o arquivo de novo.
      const rootEntries = fs
        .readdirSync(tmpExtractDir, { withFileTypes: true })
        .map((e) => e.name + (e.isDirectory() ? "/" : ""));
      return {
        success: false,
        needsConfirmation: true,
        tmpDir: tmpExtractDir,
        rootEntries,
        archivePath,
        message: "Estrutura de arquivo incomum: não encontrei DLL, package.json nem pasta user/BepInEx."
      };
    }

    cleanup(tmpExtractDir);
    addToRegistry(clientRoot, {
      id: modId,
      displayName: modId,
      type,
      installedAt: new Date().toISOString(),
      source: "archive-install",
      forgeName: forgeInfo?.name,
      forgeAuthor: forgeInfo?.author,
      forgeVersion: forgeInfo?.version,
      forgeGuid: forgeInfo?.guid
    });
    return { success: true, message: `Mod "${modId}" instalado e verificado como ${type === "server" ? "server mod" : "client mod"}.` };
  } catch (err) {
    cleanup(tmpExtractDir);
    return { success: false, message: "Erro ao instalar: " + (err as Error).message };
  }
}

/**
 * Copia o conteúdo de `mergeRoot` (uma pasta que já tem "user/" e/ou "BepInEx/" dentro,
 * seja porque foi auto-detectada, seja porque o usuário confirmou uma estrutura incomum)
 * pra dentro da instância SPT, registra cada mod encontrado individualmente, e rastreia
 * qualquer arquivo "solto" por manifesto. Compartilhada entre o fluxo normal de
 * instalação e a confirmação manual de estrutura incomum.
 *
 * Quando a instância é "dividida" (clientRoot !== serverRoot), a cópia é dividida também:
 * tudo que está dentro de "user/" vai pro serverRoot, e o resto (BepInEx/ e qualquer
 * arquivo solto na raiz do mod) vai pro clientRoot. Em instâncias normais (a grande
 * maioria) clientRoot e serverRoot são a mesma pasta, então isso não muda nada na prática.
 */
/**
 * Alguns mods empacotam a parte de servidor dentro de uma pasta-embrulho (quase sempre
 * chamada "SPT"), lado a lado com o BepInEx solto na raiz:
 *
 *   BepInEx/plugins/FooClient/     <- direto na raiz
 *   SPT/user/mods/Foo/             <- embrulhado
 *
 * Como existe "BepInEx" na raiz, findMergeRoot para ali e nunca entra no embrulho —
 * então a parte de servidor não era reconhecida (ficava sem registro, aparecendo como
 * "instalado manualmente") e, numa instalação não-dividida, ainda era copiada pro lugar
 * errado (<raiz>/SPT/user/mods em vez de <raiz>/user/mods).
 *
 * Aqui a gente achata esses embrulhos ANTES da mesclagem, movendo "user"/"BepInEx" de
 * dentro deles pra raiz da extração. Assim o resto da lógica funciona sem saber que o
 * embrulho existiu. É tudo dentro da pasta temporária, então mover é barato.
 */
function flattenWrapperDirs(mergeRoot: string): void {
  for (const entry of fs.readdirSync(mergeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    if (lower === "user" || lower === "bepinex") continue; // já está no lugar certo

    const wrapperPath = path.join(mergeRoot, entry.name);
    const inner = fs.readdirSync(wrapperPath, { withFileTypes: true });
    const relevant = inner.filter(
      (e) => e.isDirectory() && (e.name.toLowerCase() === "user" || e.name.toLowerCase() === "bepinex")
    );
    if (relevant.length === 0) continue; // não é embrulho, é conteúdo do mod mesmo

    for (const folder of relevant) {
      const from = path.join(wrapperPath, folder.name);
      const to = path.join(mergeRoot, folder.name);
      if (fs.existsSync(to)) {
        // Já existe na raiz (ex: BepInEx nos dois lugares) — funde em vez de sobrescrever.
        copyRecursive(from, to);
        fs.rmSync(from, { recursive: true, force: true });
      } else {
        fs.renameSync(from, to);
      }
    }
    // Remove o embrulho se não sobrou nada dentro dele.
    if (fs.readdirSync(wrapperPath).length === 0) {
      fs.rmSync(wrapperPath, { recursive: true, force: true });
    }
  }
}

function performMerge(
  clientRoot: string,
  serverRoot: string,
  mergeRoot: string,
  archivePath: string,
  tmpExtractDir: string,
  preferredDisplayName?: string,
  forgeInfo?: ForgeInstallInfo
): InstallResult {
  flattenWrapperDirs(mergeRoot);
  const mergeEntries = fs.readdirSync(mergeRoot, { withFileTypes: true });
  const hasUserFolder = mergeEntries.some((e) => e.isDirectory() && e.name.toLowerCase() === "user");
  const hasBepInExFolder = mergeEntries.some((e) => e.isDirectory() && e.name.toLowerCase() === "bepinex");

  // Antes de copiar/limpar, anota os nomes das pastas de mod reais que estão vindo
  // (ex: "EpicsAIO" dentro de "user/mods/"), pra registrar cada uma individualmente
  // depois — em vez de perder essa informação assim que a pasta temporária for apagada.
  const serverModNames: string[] = [];
  const clientModNames: string[] = [];
  if (hasUserFolder) {
    const srcModsDir = path.join(mergeRoot, "user", "mods");
    if (fs.existsSync(srcModsDir)) {
      for (const entry of fs.readdirSync(srcModsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) serverModNames.push(entry.name);
      }
    }
  }
  if (hasBepInExFolder) {
    const srcPluginsDir = path.join(mergeRoot, "BepInEx", "plugins");
    if (fs.existsSync(srcPluginsDir)) {
      for (const entry of fs.readdirSync(srcPluginsDir, { withFileTypes: true })) {
        if (isProtectedClientEntry(entry.name)) continue; // nunca registra o core da própria SPT como mod
        if (entry.isDirectory() || entry.name.endsWith(".dll")) clientModNames.push(entry.name);
      }
    }
  }

  // Qualquer arquivo que não caia dentro de uma dessas pastas nomeadas é "órfão" —
  // ex: algo solto direto em user/ ou BepInEx/ fora de mods/plugins. Rastreamos esses
  // caminhos num manifesto antes de apagar a pasta temporária, pra não perder o rastro.
  const allCopiedFiles = listFilesRelative(mergeRoot);
  const attributedPrefixes = [
    ...serverModNames.map((name) => `user/mods/${name}/`),
    ...clientModNames.map((name) => `BepInEx/plugins/${name}/`)
  ];
  const attributedExactFiles = new Set(clientModNames.map((name) => `BepInEx/plugins/${name}`));
  const orphanFiles = allCopiedFiles.filter(
    (f) =>
      !attributedExactFiles.has(f) &&
      !attributedPrefixes.some((prefix) => f.startsWith(prefix)) &&
      // Nunca rastrear o core da SPT: além de não ser copiado, se entrasse no manifesto
      // remover o mod apagaria o núcleo do client.
      !isProtectedInstancePath(f)
  );

  // Cópia dividida: "user/" vai pro serverRoot, o resto (BepInEx/ e qualquer arquivo
  // solto na raiz) vai pro clientRoot. Quando as duas raízes são a mesma pasta, dá
  // exatamente no mesmo resultado de sempre.
  const userSrc = path.join(mergeRoot, "user");
  if (hasUserFolder) {
    copyRecursive(userSrc, path.join(serverRoot, "user"));
    const verification = verifyCopyRecursive(userSrc, path.join(serverRoot, "user"));
    if (!verification.ok) {
      cleanup(tmpExtractDir);
      return { success: false, message: `Instalação incompleta: arquivo não confirmado no destino (${verification.missing}).` };
    }
  }
  const skippedCoreFiles: string[] = [];
  for (const entry of mergeEntries) {
    if (entry.name.toLowerCase() === "user") continue; // já tratado acima
    const srcPath = path.join(mergeRoot, entry.name);
    const destPath = path.join(clientRoot, entry.name);
    if (entry.isDirectory()) {
      copyRecursiveProtected(srcPath, destPath, entry.name, skippedCoreFiles);
      const verification = verifyCopyRecursive(srcPath, destPath, skippedCoreFiles, entry.name);
      if (!verification.ok) {
        cleanup(tmpExtractDir);
        return { success: false, message: `Instalação incompleta: arquivo não confirmado no destino (${verification.missing}).` };
      }
    } else if (!isProtectedInstancePath(entry.name)) {
      ensureDir(clientRoot);
      fs.copyFileSync(srcPath, destPath);
    } else {
      skippedCoreFiles.push(entry.name);
    }
  }

  cleanup(tmpExtractDir);
  const mergedType: ModType = hasUserFolder && hasBepInExFolder ? "hybrid" : hasUserFolder ? "server" : hasBepInExFolder ? "client" : "unknown";

  // Se der pra saber com certeza que o(s) arquivo(s) solto(s) pertencem a um único mod
  // nomeado desse mesmo install (o caso comum: um .cfg avulso ao lado da pasta real do
  // plugin), a gente liga os dois — remover um remove o outro, pra nunca sobrar lixo nem
  // "quebrar" o mod por remover só a metade. Se tiver mais de um mod nomeado no mesmo
  // install, não dá pra saber a qual pertence, então não liga nenhum.
  const orphanId = orphanFiles.length > 0 ? "hybrid-manifest-" + Date.now() : undefined;
  // Os arquivos soltos pertencem ao PACOTE, não a um mod específico — um arquivo pode
  // instalar a parte de servidor e a de cliente ao mesmo tempo (ex: mpstark-dynamicmaps
  // + DynamicMaps) e o config solto é dos dois. Por isso todo mod nomeado desse mesmo
  // arquivo aponta pros arquivos soltos, e eles só somem quando o ÚLTIMO deles sai.
  const allNamedModIds = [...serverModNames, ...clientModNames];

  // Todas as partes vindas deste mesmo arquivo compartilham um id de pacote — é o que
  // permite tratar "Wedge servidor" e "Wedge cliente" como um mod só depois.
  const packageId = `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (const name of serverModNames) {
    addToRegistry(clientRoot, {
      id: name,
      displayName: name,
      type: "server",
      installedAt: new Date().toISOString(),
      source: "archive-install",
      packageId,
      linkedModId: orphanId
    });
  }
  for (const name of clientModNames) {
    addToRegistry(clientRoot, {
      id: name,
      displayName: name,
      type: "client",
      installedAt: new Date().toISOString(),
      source: "archive-install",
      packageId,
      linkedModId: orphanId
    });
  }
  if (orphanId) {
    // Reinstalar o mesmo mod não pode empilhar entradas: o id do órfão é baseado em
    // timestamp, então cada instalação criava mais uma. Remove as anteriores do mesmo
    // pacote antes de registrar a nova.
    const orphanDisplayName = preferredDisplayName ?? path.parse(archivePath).name;
    for (const previous of loadRegistry(clientRoot)) {
      const isSamePackageOrphan =
        previous.id.startsWith("hybrid-manifest-") && previous.displayName === orphanDisplayName;
      if (isSamePackageOrphan) {
        removeManifestEntry(clientRoot, previous.id);
        removeFromRegistry(clientRoot, previous.id);
      }
    }

    // Registra como um mod "órfão" rastreado por manifesto — não tem pasta própria pra
    // habilitar/desabilitar, mas pelo menos aparece na lista e pode ser removido de forma limpa.
    addManifestEntry(clientRoot, orphanId, orphanFiles);
    addToRegistry(clientRoot, {
      id: orphanId,
      displayName: preferredDisplayName ?? path.parse(archivePath).name,
      type: mergedType,
      installedAt: new Date().toISOString(),
      source: "archive-install",
      linkedModIds: allNamedModIds
    });
  }
  if (skippedCoreFiles.length > 0) {
    return {
      success: true,
      message: `Mod instalado. ${skippedCoreFiles.length} arquivo(s) do núcleo do SPT vieram no pacote e foram ignorados, pra não quebrar a instalação.`
    };
  }
  return { success: true, message: "Mod instalado e verificado (estrutura completa detectada)." };
}

/**
 * Só aceita operar em pastas que o próprio Manager criou pra extração temporária desta
 * instância — nunca um caminho arbitrário vindo do processo renderer, que não é
 * totalmente confiável pra apagar ou mesclar coisas direto na instância SPT. As pastas
 * temporárias são sempre criadas dentro de clientRoot (ver installModFromArchive acima).
 */
function isOwnTempExtractDir(clientRoot: string, tmpDir: string): boolean {
  const resolved = path.resolve(tmpDir);
  const expectedParent = path.resolve(clientRoot);
  return path.dirname(resolved) === expectedParent && path.basename(resolved).startsWith(".tmp-mod-extract-");
}

// Usada quando o usuário revisa uma estrutura de arquivo incomum e escolhe "Continuar
// mesmo assim" — reaproveita a extração já feita (sem baixar/extrair de novo) e força a
// mesclagem direto na instância SPT.
export function finalizeUnrecognizedInstall(
  clientRoot: string,
  serverRoot: string,
  tmpDir: string,
  archivePath: string,
  preferredDisplayName?: string
): InstallResult {
  if (!isOwnTempExtractDir(clientRoot, tmpDir)) {
    return { success: false, message: "Caminho temporário inválido." };
  }
  if (!fs.existsSync(tmpDir)) {
    return { success: false, message: "A extração temporária não existe mais — tente instalar o arquivo de novo." };
  }
  return performMerge(clientRoot, serverRoot, tmpDir, archivePath, tmpDir, preferredDisplayName);
}

// Usada quando o usuário aborta depois de revisar uma estrutura de arquivo incomum.
export function discardPendingInstall(clientRoot: string, tmpDir: string): { success: boolean; message: string } {
  if (!isOwnTempExtractDir(clientRoot, tmpDir)) {
    return { success: false, message: "Caminho temporário inválido." };
  }
  cleanup(tmpDir);
  return { success: true, message: "Instalação cancelada." };
}

// --- Habilitar/desabilitar (move entre pasta ativa e .disabled) ---
/**
 * Move a pasta de um mod entre a pasta ativa e a .disabled. Devolve false quando não há
 * o que mover (não existe na origem, ou o destino já está ocupado).
 */
function moveModEntry(clientRoot: string, serverRoot: string, id: string, type: ModType, enable: boolean): boolean {
  const isServer = type === "server";
  const base = isServer ? serverRoot : clientRoot;
  const activeDir = p(base, isServer ? SERVER_MODS_DIR : CLIENT_PLUGINS_DIR);
  const disabledDir = p(base, isServer ? SERVER_MODS_DISABLED_DIR : CLIENT_PLUGINS_DISABLED_DIR);
  const from = enable ? path.join(disabledDir, id) : path.join(activeDir, id);
  const to = enable ? path.join(activeDir, id) : path.join(disabledDir, id);
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  ensureDir(enable ? activeDir : disabledDir);
  fs.renameSync(from, to);
  return true;
}

/** As outras partes do mesmo pacote (ex: a metade servidor de um mod client+server). */
function findPackageSiblings(clientRoot: string, modId: string, modType: ModType): RegistryEntry[] {
  const registry = loadRegistry(clientRoot);
  const own = registry.find((r) => r.id === modId && r.type === modType);
  if (!own?.packageId) return [];
  // Compara por id + tipo: as duas metades do Wedge têm o mesmo id, e comparar só por id
  // descartaria justamente a outra parte que a gente quer alternar junto.
  return registry.filter(
    (r) => r.packageId === own.packageId && !(r.id === modId && r.type === modType) && !r.id.startsWith("hybrid-manifest-")
  );
}

export function toggleMod(clientRoot: string, serverRoot: string, mod: ModInfo): { success: boolean; message: string } {
  if (mod.type === "client" && isProtectedClientEntry(mod.id)) {
    return { success: false, message: "Esse item é um arquivo do próprio SPT (não é um mod) e não pode ser alternado." };
  }

  const isServer = mod.type === "server";
  const base = isServer ? serverRoot : clientRoot;
  const activeDir = p(base, isServer ? SERVER_MODS_DIR : CLIENT_PLUGINS_DIR);
  const disabledDir = p(base, isServer ? SERVER_MODS_DISABLED_DIR : CLIENT_PLUGINS_DISABLED_DIR);
  ensureDir(disabledDir);
  ensureDir(activeDir);

  const from = mod.enabled ? path.join(activeDir, mod.id) : path.join(disabledDir, mod.id);
  const to = mod.enabled ? path.join(disabledDir, mod.id) : path.join(activeDir, mod.id);

  if (!fs.existsSync(from)) {
    return { success: false, message: "Arquivo/pasta do mod não encontrado: " + from };
  }
  fs.renameSync(from, to);

  // A pasta de dados que acompanha um .dll solto precisa acompanhar o habilitar/
  // desabilitar também — senão o plugin é movido e os dados dele ficam pra trás.
  if (!isServer && mod.id.toLowerCase().endsWith(".dll")) {
    const baseName = mod.id.slice(0, -4);
    const companionFrom = path.join(mod.enabled ? activeDir : disabledDir, baseName);
    const companionTo = path.join(mod.enabled ? disabledDir : activeDir, baseName);
    if (fs.existsSync(companionFrom) && fs.statSync(companionFrom).isDirectory() && !fs.existsSync(companionTo)) {
      fs.renameSync(companionFrom, companionTo);
    }
  }

  // Prepatchers do mesmo mod acompanham o habilitar/desabilitar. Sem isso, desabilitar
  // o Wedge (por exemplo) movia Wedge.Client.dll mas deixava Wedge.Prepatch.dll rodando.
  let movedPatchers = 0;
  if (!isServer) {
    const patchersActive = p(clientRoot, CLIENT_PATCHERS_DIR);
    const patchersDisabled = p(clientRoot, CLIENT_PATCHERS_DISABLED_DIR);
    const patchersFrom = mod.enabled ? patchersActive : patchersDisabled;
    const patchersTo = mod.enabled ? patchersDisabled : patchersActive;

    const registryEntry = loadRegistry(clientRoot).find((r) => r.id === mod.id);
    const manifestFiles = registryEntry?.linkedModId
      ? (loadManifest(clientRoot)[registryEntry.linkedModId] ?? [])
      : [];

    const related = findRelatedPatcherFiles(patchersFrom, mod.id, manifestFiles);
    if (related.length > 0) {
      ensureDir(patchersTo);
      for (const filePath of related) {
        const target = path.join(patchersTo, path.basename(filePath));
        if (!fs.existsSync(target)) {
          fs.renameSync(filePath, target);
          movedPatchers++;
        }
      }
    }
  }

  // As outras partes do mesmo pacote acompanham: um mod com metade servidor e metade
  // cliente meio desabilitado normalmente não funciona, e o usuário quase nunca quer isso.
  let movedSiblings = 0;
  if (mod.packageId?.startsWith("inferred:")) {
    // Pacote inferido: as partes podem ter nomes DIFERENTES ("MoreBotsServer" e
    // "MoreBotsAPI"), então quem sabe quais são é o scan — que já mandou os ids no
    // próprio mod. Sem isso, só agrupava quando os nomes eram idênticos.
    for (const sibling of mod.packageSiblings ?? []) {
      if (moveModEntry(clientRoot, serverRoot, sibling.id, sibling.type, !mod.enabled)) movedSiblings++;
    }
  } else {
    for (const sibling of findPackageSiblings(clientRoot, mod.id, mod.type)) {
      if (moveModEntry(clientRoot, serverRoot, sibling.id, sibling.type, !mod.enabled)) movedSiblings++;
    }
  }

  if (movedSiblings > 0) {
    return {
      success: true,
      message: mod.enabled
        ? `Mod desabilitado (${movedSiblings + 1} partes do pacote).`
        : `Mod habilitado (${movedSiblings + 1} partes do pacote).`
    };
  }

  if (movedPatchers > 0) {
    return {
      success: true,
      message: mod.enabled
        ? `Mod desabilitado (e ${movedPatchers} patcher(s) junto).`
        : `Mod habilitado (e ${movedPatchers} patcher(s) junto).`
    };
  }
  return { success: true, message: mod.enabled ? "Mod desabilitado." : "Mod habilitado." };
}

// --- Desinstalar ---
export function uninstallMod(clientRoot: string, serverRoot: string, mod: ModInfo): { success: boolean; message: string } {
  if (mod.type === "client" && isProtectedClientEntry(mod.id)) {
    return { success: false, message: "Esse item é um arquivo do próprio SPT (não é um mod) e não pode ser removido pelo Manager." };
  }

  // Mods "órfãos" (manifestOnly) não têm uma pasta própria com o nome do mod —
  // são arquivos soltos rastreados individualmente no manifesto. Precisa apagar
  // cada arquivo listado, em vez de tentar achar uma pasta chamada `mod.id`.
  if (mod.manifestOnly) {
    const manifest = loadManifest(clientRoot);
    const files = manifest[mod.id];
    if (!files || files.length === 0) {
      // Registro já estava vazio/inconsistente — ainda assim limpa a entrada
      // da lista pra não deixar um fantasma que ninguém consegue remover.
      removeManifestEntry(clientRoot, mod.id);
      removeFromRegistry(clientRoot, mod.id, mod.type);
      return { success: true, message: "Entrada removida da lista (nenhum arquivo rastreado)." };
    }
    let removedCount = 0;
    for (const relPath of files) {
      const target = resolveManifestFilePath(clientRoot, serverRoot, relPath);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        removedCount++;
      }
    }
    removeManifestEntry(clientRoot, mod.id);
    removeFromRegistry(clientRoot, mod.id);
    return { success: true, message: `${removedCount} arquivo(s) órfão(s) removido(s).` };
  }

  const isServer = mod.type === "server";
  const base = isServer ? serverRoot : clientRoot;
  const dir = p(base, mod.enabled ? (isServer ? SERVER_MODS_DIR : CLIENT_PLUGINS_DIR) : isServer ? SERVER_MODS_DISABLED_DIR : CLIENT_PLUGINS_DISABLED_DIR);
  const target = path.join(dir, mod.id);
  if (!fs.existsSync(target)) {
    return { success: false, message: "Mod não encontrado: " + target };
  }
  fs.rmSync(target, { recursive: true, force: true });

  // Prepatchers do mod saem junto na remoção — nas duas pastas, já que o mod pode estar
  // desabilitado no momento em que é removido.
  if (!isServer) {
    for (const patchersDir of [p(clientRoot, CLIENT_PATCHERS_DIR), p(clientRoot, CLIENT_PATCHERS_DISABLED_DIR)]) {
      for (const filePath of findRelatedPatcherFiles(patchersDir, mod.id)) {
        // Pode ser arquivo OU pasta: alguns mods põem os patchers numa subpasta
        // (BepInEx/patchers/Wedge/), então a remoção precisa ser recursiva.
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }
  }

  // Client mod solto (.dll) costuma ter uma pasta de dados de mesmo nome ao lado —
  // ela não é listada como mod (é dado dele), então precisa sair junto.
  if (!isServer && mod.id.toLowerCase().endsWith(".dll")) {
    const companion = path.join(dir, mod.id.slice(0, -4));
    if (fs.existsSync(companion) && fs.statSync(companion).isDirectory()) {
      fs.rmSync(companion, { recursive: true, force: true });
    }
  }

  // Remove também os arquivos soltos que vieram no mesmo arquivo desse mod. Eles
  // não aparecem como item separado na lista (ver scanMods), então precisam sair
  // junto — do contrário ficariam órfãos de verdade, sem dono e sem como remover.
  const registryAfter = loadRegistry(clientRoot);
  const registryEntry = registryAfter.find((r) => r.id === mod.id);
  let linkedFilesRemoved = 0;
  // Só remove os arquivos do pacote quando nenhum outro mod do mesmo arquivo continua
  // instalado — senão apagaria o config de um mod que ainda está lá.
  const orphanEntry =
    (registryEntry?.linkedModId ? registryAfter.find((r) => r.id === registryEntry.linkedModId) : undefined) ??
    // Vínculo implícito (ver scanMods): órfão com o mesmo nome de exibição desse mod.
    registryAfter.find((r) => r.id.startsWith("hybrid-manifest-") && r.displayName === mod.id);
  // Um "irmão" pode ser de outro tipo (o pacote instala server e client), e pode estar
  // habilitado ou desabilitado — por isso checamos as quatro combinações.
  const siblingsStillInstalled = (orphanEntry?.linkedModIds ?? []).some((id) => {
    if (id === mod.id) return false;
    return (["server", "client"] as const).some((type) =>
      [true, false].some((enabled) => fs.existsSync(resolveModPath(clientRoot, serverRoot, { id, type, enabled })))
    );
  });
  if (orphanEntry && !siblingsStillInstalled) {
    const manifest = loadManifest(clientRoot);
    for (const relPath of manifest[orphanEntry.id] ?? []) {
      const linkedTarget = resolveManifestFilePath(clientRoot, serverRoot, relPath);
      if (fs.existsSync(linkedTarget)) {
        fs.rmSync(linkedTarget, { force: true });
        linkedFilesRemoved++;
      }
    }
    removeManifestEntry(clientRoot, orphanEntry.id);
    removeFromRegistry(clientRoot, orphanEntry.id);
  }

  removeFromRegistry(clientRoot, mod.id, mod.type);
  return {
    success: true,
    message:
      linkedFilesRemoved > 0
        ? `Mod removido (e ${linkedFilesRemoved} arquivo(s) que vieram junto).`
        : "Mod removido."
  };
}

// --- Helpers de sistema de arquivos ---
function copyRecursive(src: string, dest: string) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Como copyRecursive, mas nunca escreve por cima do núcleo do client da SPT. `relPrefix`
 * é o caminho já percorrido a partir da raiz da instância, pra decidir a proteção pelo
 * caminho completo (e não só pelo nome do arquivo). Devolve o que foi pulado, pra poder
 * avisar quem instalou.
 */
function copyRecursiveProtected(src: string, dest: string, relPrefix = "", skipped: string[] = []): string[] {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (isProtectedInstancePath(rel)) {
      skipped.push(rel);
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursiveProtected(srcPath, destPath, rel, skipped);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  return skipped;
}

function findFilesRecursive(dir: string, extOrName: string): string[] {
  let results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findFilesRecursive(fullPath, extOrName));
    } else if (entry.name.toLowerCase().endsWith(extOrName.toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

function cleanup(tmpDir: string) {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Alguns mods vêm com uma pasta "embrulho" no topo do zip (ex: "SPT/user/mods/NomeDoMod"
 * em vez de "user/mods/NomeDoMod" direto na raiz — comum quando quem empacotou o mod
 * simplesmente zipou a pasta da própria instância). Isso procura recursivamente (até
 * alguns níveis de profundidade) por uma pasta que tenha "user" e/ou "BepInEx" como
 * filhos diretos, em vez de olhar só o nível mais raso do zip extraído.
 */
function findMergeRoot(dir: string, depth = 0): string | null {
  if (depth > 5) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hasUser = entries.some((e) => e.isDirectory() && e.name.toLowerCase() === "user");
  const hasBepInEx = entries.some((e) => e.isDirectory() && e.name.toLowerCase() === "bepinex");
  if (hasUser || hasBepInEx) return dir;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findMergeRoot(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Confere, arquivo por arquivo, que tudo que existia em src também existe em dest
 * (mesmo tamanho). Usado pra confirmar que uma instalação realmente terminou com sucesso,
 * em vez de assumir que copyRecursive não falhou silenciosamente.
 */
function verifyCopyRecursive(
  src: string,
  dest: string,
  // Arquivos deliberadamente não copiados (núcleo da SPT que veio junto no pacote) —
  // sem isso a verificação acusaria "instalação incompleta" por algo que a gente
  // decidiu pular de propósito.
  intentionallySkipped: string[] = [],
  relPrefix = ""
): { ok: boolean; missing?: string } {
  const skippedSet = new Set(intentionallySkipped);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (skippedSet.has(rel) || isProtectedInstancePath(rel)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const result = verifyCopyRecursive(srcPath, destPath, intentionallySkipped, rel);
      if (!result.ok) return result;
    } else {
      if (!fs.existsSync(destPath)) return { ok: false, missing: destPath };
      if (fs.statSync(srcPath).size !== fs.statSync(destPath).size) {
        return { ok: false, missing: destPath };
      }
    }
  }
  return { ok: true };
}

/* ==========================================================================
 * Integração com a API da Forge (forge.sp-tarkov.com) — plataforma oficial
 * de mods do SPT. API pública, só leitura, sem chave necessária. Limite de
 * uso: 40 requisições/10s em rajada, 200/60s sustentado — por isso as
 * buscas de nome abaixo são feitas uma de cada vez com um intervalo entre
 * elas, em vez de disparar tudo de uma vez.
 * ========================================================================== */

const FORGE_API_BASE = "https://forge.sp-tarkov.com/api/v0";

export interface ForgeUpdateItem {
  name: string;
  currentVersion?: string;
  recommendedVersion?: string;
  downloadLink?: string;
  guid?: string; // identificador da Forge, gravado ao atualizar pelo app
  reason?: string;
}

export interface ForgeUpdateCheckResult {
  sptVersionUsed: string;
  updates: ForgeUpdateItem[];
  blocked: ForgeUpdateItem[];
  upToDate: ForgeUpdateItem[];
  incompatible: ForgeUpdateItem[];
  infoOnly: ForgeUpdateItem[];
  unmatched: string[];
  skippedByBudget?: string[]; // não consultados: o orçamento de requisições acabou antes
}

export interface ForgeSptVersion {
  version: string;
  modCount: number;
}

// Lista de versões do SPT que a própria Forge conhece — usada pra montar um
// seletor em vez de depender de digitação livre (evita erro de digitação e
// versão inválida).
export async function getForgeSptVersions(): Promise<ForgeSptVersion[]> {
  // A API não aceita version_major/minor/patch como parâmetro de ORDENAÇÃO
  // (só como campo de dado) — pediria "3.9.0" depois de "3.10.0" se a gente
  // ordenasse pela string "version" (comparação alfabética, não numérica).
  // Pede os números separados e ordena certinho aqui mesmo.
  const url = `${FORGE_API_BASE}/spt/versions?per_page=50&fields=version,mod_count,version_major,version_minor,version_patch`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const json: any = await res.json();
    const list = (json?.data || []).map((v: any) => ({
      version: v.version as string,
      modCount: v.mod_count as number,
      major: v.version_major ?? 0,
      minor: v.version_minor ?? 0,
      patch: v.version_patch ?? 0
    }));
    list.sort((a: any, b: any) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
    return list.map(({ version, modCount }: any) => ({ version, modCount }));
  } catch {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A gente só guarda o NOME do mod localmente, não um ID/GUID da Forge — então
// achar o mod certo lá é por busca de nome (heurística). Funciona bem pra
// nomes específicos, pode errar em casos raros de nome genérico/duplicado.
// Já traz a versão mais recente conhecida junto (via include=versions), numa
// chamada só — útil pra mods sem versão local legível (ex: mods puramente
// .dll sem package.json, tipo o SVM), onde não dá pra comparar mas ainda dá
// pra mostrar "essa é a versão mais recente que a Forge conhece".
/* --------------------------------------------------------------------------
 * Casamento de mod instalado -> mod da Forge.
 *
 * O nome da pasta quase nunca é igual ao nome publicado na Forge:
 *   "DrakiaXYZ-BigBrain"                -> "BigBrain"
 *   "unbreakableKeys"                   -> "Unbreakable keys"
 *   "acidphantasm-bosseshavelegamedals" -> "Bosses Have Lega Medals"
 * Por isso a busca só por nome exato (como era antes) falhava na maioria dos
 * mods, e quase tudo caía em "não encontrado".
 *
 * Agora tentamos várias estratégias, da mais confiável pra menos:
 *   1. slug exato          (derivado do nome da pasta, inclusive quebrando camelCase)
 *   2. nome exato
 *   3. slug/nome sem o prefixo de autor ("DrakiaXYZ-" etc.)
 *   4. busca full-text     (último recurso)
 *
 * As estratégias 3 e 4 podem gerar candidato genérico demais ("Amands-Graphics"
 * vira "graphics"), então elas SÓ são aceitas se passarem numa verificação de
 * plausibilidade. Casar errado é pior que não casar: além de mostrar
 * "atualização disponível" mentirosa, o restaurador de modlist usa esse mesmo
 * casamento pra baixar mod automaticamente — casar errado instalaria o mod errado.
 * ------------------------------------------------------------------------ */

function slugifyName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // camelCase -> camel-Case
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

// Reduz a uma forma comparável: só letras e números, minúsculo. Usado pra
// verificar se um resultado da Forge realmente corresponde ao que pedimos.
function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitAuthorPrefix(name: string): { author?: string; rest: string } {
  // O ponto é tão comum quanto o hífen como separador de autor: numa instalação real,
  // 16 mods não casavam só por isso (Tyfon.UIFixes, IcyClawz.ItemAttributeFix,
  // Kat.BetterAmmoLoadingList, Tosox.DynamicItemWeights, ...).
  const match = /^([A-Za-z0-9]+)[-_.](.+)$/.exec(name);
  // O resto precisa ter letra: senão "SAIN.4.4.3" viraria autor "SAIN" + nome "4.4.3",
  // e o sufixo de versão seria tratado como se fosse o nome do mod.
  if (match && match[2].length >= 3 && /[a-zA-Z]/.test(match[2])) {
    return { author: match[1], rest: match[2] };
  }
  return { rest: name };
}

/**
 * Pasta nomeada com o GUID do mod ("com.swiftxp.spt.showmethemoney"). O último segmento
 * costuma ser o nome, e o segundo, o autor — que serve de verificação.
 */
function splitGuidLikeFolder(name: string): { author?: string; rest?: string } {
  const parts = name.split(".");
  if (parts.length < 3) return {};
  if (!/^(com|org|net|me|xyz|io|dev)$/i.test(parts[0])) return {};
  return { author: parts[1], rest: parts[parts.length - 1] };
}

interface MatchCandidates {
  strictSlugs: string[]; // derivados do nome COMPLETO da pasta — alta confiança
  strictNames: string[];
  looseSlugs: string[]; // sem o prefixo de autor — precisam de verificação
  looseNames: string[];
  authorHint?: string;
}

/**
 * Tira do nome da pasta o que não faz parte do nome do mod na Forge. Padrões vistos numa
 * instalação real de 136 mods, todos falhando o casamento antes disso:
 *
 *   "WTT-PackNStrap-2.0.4"  -> "WTT-PackNStrap"    (versão anexada na pasta)
 *   "SAIN.4.4.3"            -> "SAIN"
 *   "MedicalAttention-Client" -> "MedicalAttention" (metade cliente de um pacote)
 *   "MergeConsumablesServer"  -> "MergeConsumables"
 *   "[SVM] Server Value Modifier" -> "Server Value Modifier"
 */
function stripFolderNameNoise(name: string): string[] {
  const variants = new Set<string>([name]);
  let current = name;

  // "[SVM] Nome" -> "Nome"
  const withoutTag = current.replace(/^\[[^\]]+\]\s*/, "").trim();
  if (withoutTag && withoutTag !== current) {
    variants.add(withoutTag);
    current = withoutTag;
  }

  // sufixo de versão: "-2.0.4", ".4.4.3", "_1.2"
  const withoutVersion = current.replace(/[-._]v?\d+(\.\d+){1,3}$/i, "").trim();
  if (withoutVersion && withoutVersion !== current) {
    variants.add(withoutVersion);
    current = withoutVersion;
  }

  // sufixo de parte do pacote: "-Client", "Server", ".Net"
  const withoutPart = current.replace(/[-._]?(client|server|\.net)$/i, "").trim();
  if (withoutPart && withoutPart.length >= 3 && withoutPart !== current) {
    variants.add(withoutPart);
  }

  return [...variants].filter(Boolean);
}

function buildMatchCandidates(folderName: string): MatchCandidates {
  const { cleanName } = stripLoadOrderPrefix(folderName); // ignora "01_" de pastas legadas
  const { author, rest } = splitAuthorPrefix(cleanName);
  const spaced = (v: string) =>
    v
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase -> camel Case
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // "UIFixes" -> "UI Fixes"
      .replace(/[-_.]+/g, " ")
      .trim();

  const guidLike = splitGuidLikeFolder(cleanName);
  const cleanVariants = [...new Set([...stripFolderNameNoise(cleanName), ...(guidLike.rest ? [guidLike.rest] : [])])];
  const strictSlugs = [...new Set(cleanVariants.map(slugifyName))].filter(Boolean);
  // No máximo 2 tentativas de nome por mod: a mais limpa primeiro (mais chance de bater
  // com o nome publicado) e a crua como reserva. Mais que isso multiplica requisições
  // sem ganho proporcional, e o orçamento é curto.
  const orderedVariants = [...cleanVariants].sort((a, b) => a.length - b.length);
  const strictNames = [...new Set(orderedVariants.flatMap((v) => [v, spaced(v)]))]
    // Variante sem letra nenhuma ("4 4 3") nunca vai casar com nome de mod — só gastaria
    // uma requisição do orçamento.
    .filter((v) => v && /[a-zA-Z]/.test(v))
    .slice(0, 3);
  const looseSlugs =
    rest !== cleanName ? [...new Set([slugifyName(rest)])].filter(Boolean) : [];
  // Ordena pela forma com espaços primeiro: o nome publicado quase sempre tem espaços
  // ("UI Fixes", "Dynamic Item Weights"), não camelCase.
  // O nome sem o autor também precisa passar pela limpeza: "Tyfon.UIFixes.Server"
  // deixa "UIFixes.Server", e o que interessa é "UI Fixes".
  const looseRaw = guidLike.rest ?? (rest !== cleanName ? rest : undefined);
  const looseBase = looseRaw ? (stripFolderNameNoise(looseRaw).sort((a, b) => a.length - b.length)[0] ?? looseRaw) : undefined;
  const looseNames = looseBase
    ? [...new Set([spaced(looseBase), looseBase])].filter((v) => v && /[a-zA-Z]/.test(v))
    : [];

  // Na pasta-GUID ("com.swiftxp.spt.showmethemoney"), o split simples pegaria "com"
  // como autor — o autor de verdade é o segundo segmento.
  return { strictSlugs, strictNames, looseSlugs, looseNames, authorHint: guidLike.author ?? author };
}

/**
 * Um casamento "solto" (sem prefixo de autor, ou via busca full-text) só vale se
 * der pra confirmar de outro jeito: ou o autor na Forge bate com o prefixo que a
 * gente tirou do nome da pasta, ou o nome publicado contém o que procuramos.
 */
function isPlausibleMatch(candidate: any, searched: string, authorHint?: string): boolean {
  const rawName = String(candidate?.name ?? "");
  // O nome PUBLICADO também pode ter prefixo em colchetes ("[SAIN] Twitch Players"),
  // então a comparação precisa considerar as duas formas dos dois lados.
  const rawNameNoTag = rawName.replace(/^\[[^\]]+\]\s*/, "").trim();
  const rawSlug = String(candidate?.slug ?? "");
  const forgeName = normalizeForCompare(rawName);
  const forgeSlug = normalizeForCompare(rawSlug);
  const forgeOwner = normalizeForCompare(String(candidate?.owner?.name ?? ""));
  const target = normalizeForCompare(searched);
  if (!target) return false;

  // 1) Igualdade — o caso ideal.
  if (forgeSlug === target || forgeName === target) return true;

  // 2) Autor confere — forte o bastante mesmo com nome diferente.
  if (authorHint && forgeOwner && forgeOwner === normalizeForCompare(authorHint)) return true;

  // 3) Nome publicado começa com o que procuramos, terminando em limite de palavra.
  //    Cobre o caso MUITO comum de a Forge usar título longo enquanto a pasta usa o
  //    nome curto: "SAIN" -> "SAIN - Solarint's AI Modifications - ...".
  //    O limite de palavra evita casar "keys" com "KeysReworked": exigimos que o que
  //    vem logo depois no nome ORIGINAL não seja letra/número.
  if (normalizeForCompare(rawNameNoTag) === target) return true;
  if (target.length >= 3 && startsWithAtWordBoundary(rawName, searched)) return true;
  if (target.length >= 3 && rawNameNoTag !== rawName && startsWithAtWordBoundary(rawNameNoTag, searched)) return true;
  if (target.length >= 3 && startsWithAtWordBoundary(rawSlug, searched)) return true;

  return false;
}

/**
 * "SAIN - Solarint's..." começa com "SAIN" seguido de espaço -> true.
 * "KeysReworked" começa com "Keys" seguido de "R" (letra) -> false.
 * A comparação ignora maiúsculas e pontuação no trecho comparado, mas exige que o
 * caractere logo após o trecho seja um separador de verdade.
 */
function startsWithAtWordBoundary(fullValue: string, prefix: string): boolean {
  const normalizedPrefix = normalizeForCompare(prefix);
  if (!normalizedPrefix) return false;
  let consumed = 0;
  let matchedChars = 0;
  for (const char of fullValue) {
    const isAlphaNum = /[a-zA-Z0-9]/.test(char);
    if (isAlphaNum) {
      if (matchedChars >= normalizedPrefix.length) return false; // ainda em palavra -> não é limite
      if (char.toLowerCase() !== normalizedPrefix[matchedChars]) return false;
      matchedChars++;
    } else if (matchedChars >= normalizedPrefix.length) {
      return true; // consumiu o prefixo inteiro e chegou num separador
    }
    consumed++;
    if (matchedChars === normalizedPrefix.length && consumed === fullValue.length) return true;
  }
  return matchedChars === normalizedPrefix.length;
}

/**
 * COMO o casamento foi feito. Isso não é telemetria: um casamento ERRADO é pior que
 * nenhum, porque o restaurador de modlist baixa e instala usando esse mesmo mapeamento
 * — casar errado instala o mod errado por cima.
 *
 * Conferido numa instalação real de 53 mods, no cache gerado pela versão anterior:
 *   "Fika"                -> "Fika Headless Launcher"      (é outro mod, de outro autor)
 *   "fika-server"         -> "Server Value Modifier [SVM]" (o guid do SVM é
 *                            "fika.ghostfenixx.svm" — começa com "fika", e a busca
 *                            por nome mordeu a isca)
 *   "WTT-ContentBackport" -> "Content Backport - Prestiges" (mod parecido, outro autor)
 * Nenhum desses aparecia como suspeito na tela: um chute ruim era indistinguível de um
 * acerto. Guardar o método é o que permite a UI dizer "confirme isso" em vez de mentir.
 */
type ForgeMatchMethod =
  | "manual" // o usuário ligou esse mod a um id da Forge na mão — nunca sobrescrever
  | "guid" // GUID declarado pelo mod == guid publicado. Sem ambiguidade possível.
  | "cached-id" // id numérico de uma checagem anterior, revalidado agora
  | "name" // nome publicado idêntico ao que procuramos
  | "fuzzy"; // busca textual + plausibilidade — É CHUTE, pode estar errado

/** Só "fuzzy" precisa de confirmação humana; o resto é verificável. */
function methodNeedsConfirmation(method: ForgeMatchMethod): boolean {
  return method === "fuzzy";
}

interface ForgeMatch {
  identifier: string;
  modId: number; // id numérico da Forge — sempre existe, mesmo quando guid é null
  latestVersion?: string;
  latestVersionLink?: string;
  forgeName?: string;
  /** Mantido por compatibilidade com o resto do código/UI que já lê esse campo. */
  confidence: "exact" | "derived";
  method: ForgeMatchMethod;
  /** true = mostrar como "precisa confirmar" em vez de afirmar que casou. */
  needsConfirmation: boolean;
  /** guid publicado na Forge, quando existe — usado pra confirmar o casamento. */
  forgeGuid?: string;
}

function toForgeMatch(entry: any, method: ForgeMatchMethod): ForgeMatch {
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  const latest = versions[0];
  return {
    identifier: typeof entry.guid === "string" ? entry.guid : String(entry.id),
    modId: Number(entry.id),
    latestVersion: latest?.version,
    latestVersionLink: latest?.link,
    forgeName: typeof entry.name === "string" ? entry.name : undefined,
    confidence: method === "fuzzy" ? "derived" : "exact",
    method,
    needsConfirmation: methodNeedsConfirmation(method),
    forgeGuid: typeof entry.guid === "string" ? entry.guid : undefined
  };
}

/* Limites documentados da API da Forge: 40 req/10s (burst) e 200 req/60s (sustentado).
 * 40/10s = 1 requisição a cada 250ms no melhor caso; usamos 320ms de folga pra não
 * encostar no limite (era 120ms antes, que dava ~83 req/10s — o dobro do permitido, e
 * por isso a checagem entrava num ciclo de 429 -> espera -> 429 que parecia travada). */
const FORGE_MIN_REQUEST_INTERVAL_MS = 320;
let lastForgeRequestAt = 0;

async function forgeRateLimitGate(): Promise<void> {
  const since = Date.now() - lastForgeRequestAt;
  if (since < FORGE_MIN_REQUEST_INTERVAL_MS) {
    await delay(FORGE_MIN_REQUEST_INTERVAL_MS - since);
  }
  lastForgeRequestAt = Date.now();
}

// Estado por execução de checagem: teto de requisições e contagem de 429, pra garantir
// que a operação SEMPRE termina em tempo previsível em vez de ficar tentando pra sempre.
interface ForgeBudget {
  remaining: number;
  rateLimitHits: number;
  aborted: boolean;
}

function newForgeBudget(modCount: number): ForgeBudget {
  // ~4 tentativas por mod (uma por estratégia), com piso e teto. O teto antigo de 160
  // truncava em silêncio quem tem instalação grande: com 118 mods, a busca parava na
  // metade e o resto era reportado como "não encontrado" sem nunca ter sido consultado.
  // Até 5 requisições por mod (3 nomes + nome sem autor + busca textual). A folga
  // importa: com o orçamento exatamente no limite, um mod que usa todas as tentativas
  // empurra outro pra fora, e o que fica de fora aparece como "não encontrado" sem
  // nunca ter sido consultado.
  return { remaining: Math.min(Math.max(modCount * 7, 30), 1400), rateLimitHits: 0, aborted: false };
}

/**
 * Requisição à Forge respeitando rate limit, orçamento e 429 (com Retry-After).
 * Devolve null em qualquer falha — o chamador segue sem quebrar a checagem inteira.
 */
async function forgeFetchJson(url: string, budget: ForgeBudget, retriedAfter429 = false): Promise<any | null> {
  if (budget.aborted || budget.remaining <= 0) return null;
  budget.remaining--;
  await forgeRateLimitGate();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "SPT-Mod-Manager" }
    });
    if (res.status === 429) {
      budget.rateLimitHits++;
      // Se continuar batendo no limite, desistir é melhor que insistir: a doc trata
      // burlar o limite como hostilidade, e o usuário prefere um resultado parcial
      // rápido a uma tela "Consultando..." parada por minutos.
      if (budget.rateLimitHits >= 3 || retriedAfter429) {
        budget.aborted = true;
        return null;
      }
      const retryAfter = Number(res.headers.get("retry-after") || 0);
      await delay(Math.min(Math.max(retryAfter, 1), 35) * 1000);
      return forgeFetchJson(url, budget, true);
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ==========================================================================
 * ATENÇÃO — BUG DA API, e a causa raiz de "não acha quase nada":
 *
 * Passar filter[include_legacy] junto com QUALQUER outro filter[...] faz a API
 * ignorar o outro filtro em silêncio e devolver o catálogo inteiro sem filtrar,
 * com HTTP 200. Conferido contra a API real:
 *
 *   filter[id]=791                                -> [791] SAIN                  (certo)
 *   filter[id]=791 + filter[include_legacy]=true  -> [2] More Variety, [3] ...    (catálogo cru)
 *   filter[id]=791,902                            -> [791] SAIN, [902] BigBrain  (lote funciona!)
 *   filter[name]=BigBrain                         -> [902] BigBrain              (certo)
 *   filter[name]=BigBrain + include_legacy        -> mesma lista de lixo
 *   filter[name]=qualquer_bobagem + include_legacy-> MESMA lista de lixo
 *
 * A versão anterior mandava include_legacy em TODAS as consultas de identidade, então
 * o lote por guid, o lote por id do cache e a busca por nome estavam todos mortos —
 * sobrava só a busca textual, que é o último recurso e roda depois de gastar ~4
 * requisições por mod à toa.
 *
 * O flag NÃO pode simplesmente sumir: sem ele a Forge esconde mods legados (sem
 * constraint de versão do SPT) — filter[id]=2 sem o flag devolve vazio. Por isso a
 * estratégia é em duas passadas: filtros de verdade primeiro (sem o flag), e o que
 * sobrar vai pra busca textual COM o flag, que é a única coisa que ele não quebra
 * (query= é Meilisearch, pipeline separado do filtro).
 * ========================================================================== */

/**
 * filter[name] é um filtro de verdade quando não está sabotado pelo include_legacy.
 * Ainda assim o resultado passa por verificação: "filtro" aqui não garante igualdade,
 * e casar errado é pior que não casar.
 */
async function fetchForgeByFuzzyFilter(filterKey: "slug" | "name", value: string, budget: ForgeBudget): Promise<any[]> {
  const url = new URL(`${FORGE_API_BASE}/mods`);
  url.searchParams.set(`filter[${filterKey}]`, value);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("include", "versions");
  // Sem restringir "fields": a restauração de modlist precisa do LINK de download de
  // cada versão, e a resposta reduzida não garante trazer esse campo. Pedir o objeto
  // completo custa alguns KB a mais e evita "não baixa nada" silencioso.
  //
  // NÃO adicionar filter[include_legacy] aqui — ver o bloco acima: mata este filtro.
  const json = await forgeFetchJson(url.toString(), budget);
  return Array.isArray(json?.data) ? json.data : [];
}

/**
 * Segunda passada, só pro que não casou: busca textual COM include_legacy, que é o
 * único jeito de alcançar mod legado (o filtro por id/guid não chega nele).
 */
async function fetchForgeByQuery(term: string, budget: ForgeBudget, perPage = 10): Promise<any[]> {
  const url = new URL(`${FORGE_API_BASE}/mods`);
  url.searchParams.set("query", term);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("include", "versions");
  // Aqui o flag é seguro E necessário: query= não passa pelo pipeline de filtro.
  url.searchParams.set("filter[include_legacy]", "true");
  const json = await forgeFetchJson(url.toString(), budget);
  return Array.isArray(json?.data) ? json.data : [];
}

// GUID SIM aceita lote de verdade — é o único caminho realmente confiável e barato.
// Uma requisição resolve dezenas de mods, sem fuzzy e sem ambiguidade.
async function fetchForgeByIds(ids: string[], budget: ForgeBudget): Promise<any[]> {
  if (ids.length === 0) return [];
  const results: any[] = [];
  const CHUNK = 25;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const url = new URL(`${FORGE_API_BASE}/mods`);
    url.searchParams.set("filter[id]", ids.slice(i, i + CHUNK).join(","));
    url.searchParams.set("per_page", "50");
    url.searchParams.set("include", "versions");
    // sem include_legacy: ele anularia o filter[id] inteiro (ver bloco acima)
    const json = await forgeFetchJson(url.toString(), budget);
    if (Array.isArray(json?.data)) results.push(...json.data);
  }
  return results;
}

async function fetchForgeByGuids(guids: string[], budget: ForgeBudget): Promise<any[]> {
  if (guids.length === 0) return [];
  const results: any[] = [];
  const CHUNK = 25;
  for (let i = 0; i < guids.length; i += CHUNK) {
    const url = new URL(`${FORGE_API_BASE}/mods`);
    url.searchParams.set("filter[guid]", guids.slice(i, i + CHUNK).join(","));
    url.searchParams.set("per_page", "50");
    url.searchParams.set("include", "versions");
    // sem include_legacy: ele anularia o filter[guid] inteiro (ver bloco acima)
    const json = await forgeFetchJson(url.toString(), budget);
    if (Array.isArray(json?.data)) results.push(...json.data);
  }
  return results;
}

/**
 * Resolve vários mods de uma vez. Retorna um mapa nome-da-pasta -> casamento.
 * Faz o grosso em poucas requisições em lote e só cai pra busca individual
 * (full-text) no que sobrar.
 */
/**
 * Cache de casamento: nome-da-pasta -> GUID resolvido na Forge.
 *
 * Achar um mod que NÃO declara GUID custa até 4 consultas (slug, nome, sem prefixo,
 * busca textual), e o ritmo é limitado pela API — ~1,2s por mod. Guardando o GUID
 * descoberto, a checagem seguinte resolve esse mod junto com os outros na consulta em
 * lote por GUID, que é uma requisição pra cada 25 mods. Na prática: a primeira checagem
 * é lenta, as próximas são quase instantâneas.
 */
const FORGE_MATCH_CACHE_FILE = ".spt-mod-manager-forge-match.json";

/**
 * IMPORTANTE: o cache guarda o ID NUMÉRICO da Forge, não o guid.
 *
 * Conferido numa resposta real da API: de 11 mods retornados numa busca, 8 tinham
 * "guid": null — só o autor que registra um GUID na plataforma tem esse campo. O id
 * numérico existe sempre. Guardar guid aqui deixava o cache inútil justamente pros mods
 * que mais precisam dele (os que não têm guid e caem nas estratégias lentas por nome).
 */
/**
 * Formato v2. O v1 era um mapa cru pasta -> id, sem registrar COMO aquilo foi
 * descoberto — então um chute ruim virava verdade permanente: uma vez gravado, todas as
 * checagens seguintes reusavam o id errado e nunca reconsideravam. Foi assim que
 * "fika-server" ficou preso em "Server Value Modifier [SVM]".
 *
 * No v2 cada entrada guarda o método. Entradas "fuzzy" (chute) são revalidadas; entradas
 * "manual" (o usuário confirmou na mão) são soberanas e nunca sobrescritas por
 * automação. Um cache v1 é DESCARTADO na leitura: não dá pra saber quais entradas dele
 * eram chute, e manter as boas não compensa manter as ruins.
 */
const FORGE_MATCH_CACHE_VERSION = 2;

interface ForgeMatchCacheEntry {
  modId: string;
  method: ForgeMatchMethod;
  guid?: string;
  verifiedAt?: string;
}

type ForgeMatchCache = Record<string, ForgeMatchCacheEntry>;

function loadForgeMatchCache(root: string): ForgeMatchCache {
  try {
    const file = path.join(root, FORGE_MATCH_CACHE_FILE);
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    // v1: mapa cru pasta -> "1234". Sem procedência, não dá pra confiar em nada dele.
    if (parsed.version !== FORGE_MATCH_CACHE_VERSION) return {};
    const entries = parsed.entries;
    if (!entries || typeof entries !== "object") return {};
    const out: ForgeMatchCache = {};
    for (const [folder, value] of Object.entries(entries as Record<string, any>)) {
      if (value && typeof value.modId === "string" && typeof value.method === "string") {
        out[folder] = value as ForgeMatchCacheEntry;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveForgeMatchCache(root: string, cache: ForgeMatchCache): void {
  try {
    const payload = { version: FORGE_MATCH_CACHE_VERSION, entries: cache };
    fs.writeFileSync(path.join(root, FORGE_MATCH_CACHE_FILE), JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // cache é otimização, não pode derrubar a checagem se falhar ao gravar
  }
}

/** Ligação feita à mão pelo usuário — tem precedência sobre qualquer automação. */
export function setManualForgeMatch(root: string, folderName: string, modId: number | string): void {
  const cache = loadForgeMatchCache(root);
  cache[folderName] = { modId: String(modId), method: "manual", verifiedAt: new Date().toISOString() };
  saveForgeMatchCache(root, cache);
}

/** Desfaz a ligação manual, devolvendo o mod pro caminho automático. */
export function clearManualForgeMatch(root: string, folderName: string): void {
  const cache = loadForgeMatchCache(root);
  if (cache[folderName]?.method === "manual") {
    delete cache[folderName];
    saveForgeMatchCache(root, cache);
  }
}

export async function matchForgeMods(
  input: (string | { folderName: string; guid?: string })[],
  onProgress?: (done: number, total: number) => void,
  cacheRoot?: string
): Promise<Map<string, ForgeMatch> & { notChecked?: Set<string> }> {
  const cache = cacheRoot ? loadForgeMatchCache(cacheRoot) : {};
  const entries = input
    .map((v) => (typeof v === "string" ? { folderName: v, guid: undefined as string | undefined } : { ...v }))
    // Already resolved by an earlier check. Only entries we can still stand behind are
    // reused: a "fuzzy" entry was a guess, so it gets re-resolved from scratch instead of
    // being promoted to fact. A "manual" entry is the user's own decision and is final.
    .map((e) => {
      const cached = cache[e.folderName];
      return {
        ...e,
        cachedId: cached && cached.method !== "fuzzy" ? cached.modId : undefined,
        pinned: cached?.method === "manual"
      };
    });
  const folderNames = entries.map((e) => e.folderName);
  const budget = newForgeBudget(folderNames.length);
  const matched = new Map<string, ForgeMatch>();
  // Mods que o orçamento de requisições não alcançou — diferente de "procurado e não
  // achado", e a UI precisa dizer isso com honestidade.
  const notChecked = new Set<string>();
  // O progresso conta MODS RESOLVIDOS, não tentativas. Contar tentativas dava um total
  // de "mods x 4 estratégias" (552 pra 136 mods), que na tela parecia uma quantidade
  // absurda de mods — e escondia o fato de que, com GUID, a maioria resolve de primeira,
  // numa requisição em lote só. Um mod conta como pronto quando casa, ou quando esgota
  // todas as estratégias.
  let exhausted = 0;
  const reportProgress = () =>
    onProgress?.(Math.min(matched.size + exhausted, folderNames.length), folderNames.length);
  const candidatesByName = new Map<string, MatchCandidates>();
  for (const folderName of folderNames) {
    candidatesByName.set(folderName, buildMatchCandidates(folderName));
  }

  // --- Passo 0: GUID (exato e em lote de verdade) ---
  // De longe o melhor caminho: filter[guid] aceita lista separada por vírgula e não é
  // fuzzy, então dezenas de mods se resolvem numa requisição só, sem chute por nome.
  // Só funciona pra mods que declaram GUID (SPT 4.0); o resto cai nos passos seguintes.
  // Lote por ID numérico: cobre tudo que já foi resolvido antes, inclusive mods sem guid.
  const cachedEntries = entries.filter((e) => e.cachedId);
  if (cachedEntries.length > 0) {
    const byId = new Map<string, any>();
    for (const entry of await fetchForgeByIds(cachedEntries.map((e) => e.cachedId!), budget)) {
      if (entry?.id !== undefined) byId.set(String(entry.id), entry);
    }
    for (const entry of cachedEntries) {
      const hit = byId.get(String(entry.cachedId));
      if (hit) matched.set(entry.folderName, toForgeMatch(hit, entry.pinned ? "manual" : "cached-id"));
    }
    reportProgress();
  }

  const guidEntries = entries.filter((e) => e.guid && !matched.has(e.folderName));
  if (guidEntries.length > 0) {
    const byGuid = new Map<string, any>();
    for (const entry of await fetchForgeByGuids(guidEntries.map((e) => e.guid!), budget)) {
      if (entry?.guid) byGuid.set(String(entry.guid).toLowerCase(), entry);
    }
    for (const entry of guidEntries) {
      const hit = byGuid.get(String(entry.guid).toLowerCase());
      if (hit) matched.set(entry.folderName, toForgeMatch(hit, "guid"));
    }
    reportProgress(); // com GUID, a maioria já fica pronta aqui
  }

  // --- Busca por nome, mod a mod ---
  //
  // São no MÁXIMO 2 requisições por mod: o filtro por nome e, se falhar, a busca textual.
  //
  // A estratégia por slug foi removida: o slug da Forge é derivado do nome PUBLICADO, que
  // é justamente o que a gente não sabe. Conferido na API real — o slug do SAIN é
  // "sain-solarints-ai-modifications-full-ai-combat-system-replacement", enquanto o do
  // Wedge é só "wedge". Ou seja, o slug só acerta quando é igual ao nome, e nesse caso a
  // busca por nome já acha. Em compensação ela custava até 2 requisições por mod.
  //
  // Isso importa porque o orçamento é limitado pelo rate limit da Forge: com 6 requisições
  // por mod, uma instalação de 136 mods estourava o orçamento na metade da lista, e os
  // mods restantes eram reportados como "não encontrado" sem nunca terem sido consultados.
  for (const [folderName, cand] of candidatesByName) {
    if (matched.has(folderName)) continue; // já resolvido pelos lotes de id/guid
    if (budget.aborted) break;

    // 1) filtro por nome (fuzzy — o resultado SEMPRE passa por verificação)
    for (const name of cand.strictNames) {
      const hits = await fetchForgeByFuzzyFilter("name", name, budget);
      const exact = hits.find((entry) => normalizeForCompare(entry?.name ?? "") === normalizeForCompare(name));
      const hit = exact ?? hits.find((entry) => isPlausibleMatch(entry, name, cand.authorHint));
      if (hit) {
        matched.set(folderName, toForgeMatch(hit, exact ? "name" : "fuzzy"));
        break;
      }
      if (budget.aborted) break;
    }

    // 2) nome sem o prefixo do autor ("Tyfon.UIFixes" -> "UI Fixes")
    //
    // Aqui a verificação é mais rígida: sem o autor, o nome vira genérico ("Pause",
    // "Skipper") e um prefixo qualquer casaria com o mod errado. Só aceita se o nome
    // publicado for igual, ou se o autor na Forge confirmar.
    if (!matched.has(folderName) && !budget.aborted) {
      for (const name of cand.looseNames.slice(0, 1)) {
        const hits = await fetchForgeByFuzzyFilter("name", name, budget);
        const hit = hits.find((entry) => {
          const target = normalizeForCompare(name);
          const forgeName = normalizeForCompare(String(entry?.name ?? ""));
          const forgeNameNoTag = normalizeForCompare(String(entry?.name ?? "").replace(/^\[[^\]]+\]\s*/, ""));
          if (forgeName === target || forgeNameNoTag === target) return true;
          const owner = normalizeForCompare(String(entry?.owner?.name ?? ""));
          return !!cand.authorHint && !!owner && owner === normalizeForCompare(cand.authorHint);
        });
        if (hit) {
          // Confirmed by exact published name OR by matching author — good enough to
          // stand behind, but it is still a name match, not an identity match.
          matched.set(folderName, toForgeMatch(hit, "name"));
          break;
        }
        if (budget.aborted) break;
      }
    }

    // 3) Full-text search, last resort. This is the ONLY path that reaches legacy mods,
    //    because filter[id]/filter[guid] cannot see them and adding include_legacy to a
    //    filtered query destroys the filter. Anything landing here is a guess and is
    //    flagged for confirmation rather than reported as a match.
    if (!matched.has(folderName) && !budget.aborted) {
      const term = cand.looseNames[0] ?? cand.strictNames[0];
      if (term) {
        const hits = await fetchForgeByQuery(term, budget, 5);
        // If the mod declares a GUID, prefer the candidate whose published guid equals
        // it — that turns a guess into a certainty, and is exactly how a legacy mod with
        // a GUID gets resolved correctly.
        const declaredGuid = entries.find((e) => e.folderName === folderName)?.guid?.toLowerCase();
        const byGuid = declaredGuid
          ? hits.find((entry: any) => String(entry?.guid ?? "").toLowerCase() === declaredGuid)
          : undefined;
        if (byGuid) {
          matched.set(folderName, toForgeMatch(byGuid, "guid"));
        } else {
          const hit = hits.find((entry: any) => isPlausibleMatch(entry, term, cand.authorHint));
          if (hit) matched.set(folderName, toForgeMatch(hit, "fuzzy"));
        }
      }
    }

    if (!matched.has(folderName)) {
      // Só conta como "procurado e não achado" se realmente deu pra procurar. Se o
      // orçamento acabou, esse mod não foi consultado — e dizer "não encontrado" nesse
      // caso é mentira.
      if (budget.aborted || budget.remaining <= 0) notChecked.add(folderName);
      else exhausted++;
    }
    reportProgress();
  }

  // Mods que sobraram sem ser consultados (orçamento acabou antes de chegar neles).
  for (const [folderName] of candidatesByName) {
    if (!matched.has(folderName) && !notChecked.has(folderName) && (budget.aborted || budget.remaining <= 0)) {
      notChecked.add(folderName);
    }
  }

  // Fecha o progresso: se o orçamento foi interrompido, sobram mods que não foram nem
  // casados nem esgotados — a operação acabou de qualquer forma.
  exhausted = folderNames.length - matched.size;
  reportProgress();

  if (cacheRoot) {
    // Persist what was resolved so the next check finds it in the cheap batch query.
    // Guesses are deliberately NOT persisted: caching a guess is how a bad match becomes
    // permanent truth. A manual pin always wins and is never overwritten here.
    const updated: ForgeMatchCache = { ...cache };
    const now = new Date().toISOString();
    for (const [folderName, match] of matched) {
      if (!match.modId) continue;
      if (cache[folderName]?.method === "manual") continue;
      if (match.method === "fuzzy") continue;
      updated[folderName] = {
        modId: String(match.modId),
        method: match.method,
        guid: match.forgeGuid,
        verifiedAt: now
      };
    }
    saveForgeMatchCache(cacheRoot, updated);
  }

  (matched as Map<string, ForgeMatch> & { notChecked?: Set<string> }).notChecked = notChecked;
  return matched;
}

async function findForgeModInfo(
  name: string,
  sptVersion?: string
): Promise<{ identifier: string; latestVersion?: string; latestVersionLink?: string; forgeName?: string } | null> {
  try {
    const url = new URL(`${FORGE_API_BASE}/mods`);
    url.searchParams.set("filter[name]", name);
    url.searchParams.set("per_page", "1");
    url.searchParams.set("include", "versions");
    url.searchParams.set("fields", "id,guid,name");
    if (sptVersion?.trim()) url.searchParams.set("filter[spt_version]", sptVersion.trim());
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const match = json?.data?.[0];
    if (!match) return null;
    const identifier = typeof match.guid === "string" ? match.guid : String(match.id);
    const versions = Array.isArray(match.versions) ? match.versions : [];
    const latest = versions[0];
    return {
      identifier,
      latestVersion: latest?.version,
      latestVersionLink: latest?.link,
      forgeName: typeof match.name === "string" ? match.name : undefined
    };
  } catch {
    return null;
  }
}

// Acha, pelo nome (o mesmo casamento exato usado na checagem de atualização), o link de
// download da versão mais recente de um mod na Forge — usado pra "restaurar" uma modlist
// importada baixando automaticamente o que estiver faltando.
/**
 * Versão em LOTE da busca por link de download, usada pra restaurar uma modlist.
 *
 * Antes o restaurador chamava findForgeDownloadForName uma vez por mod. Cada chamada
 * criava um orçamento NOVO, então a proteção de "desistir depois de 3 respostas 429"
 * reiniciava a cada mod: bastava a API começar a limitar pra que cada um dos 118 mods
 * esperasse o Retry-After (até 35s) por conta própria. Compartilhando um orçamento só,
 * a operação inteira desiste junto e termina em tempo previsível.
 */
export async function findForgeDownloadsForNames(
  entries: { name: string; guid?: string }[],
  onProgress?: (done: number, total: number) => void,
  cacheRoot?: string
): Promise<Record<string, { downloadLink: string; version?: string; forgeName?: string; guid?: string }>> {
  // Quando a lista exportada traz o GUID, o casamento é exato e resolvido em lote —
  // sem adivinhação por nome. Listas antigas (sem GUID) continuam funcionando pelo nome.
  const matches = await matchForgeMods(
    entries.map((e) => ({ folderName: e.name, guid: e.guid })),
    onProgress,
    cacheRoot
  );
  const out: Record<string, { downloadLink: string; version?: string; forgeName?: string; guid?: string }> = {};
  const budget = newForgeBudget(entries.length);
  for (const { name } of entries) {
    const info = matches.get(name);
    if (!info) continue;

    if (info.latestVersionLink) {
      out[name] = {
        downloadLink: info.latestVersionLink,
        version: info.latestVersion,
        forgeName: info.forgeName,
        guid: info.identifier
      };
      continue;
    }

    // Casou com o mod na Forge, mas a resposta não trouxe o link de download. Em vez de
    // desistir em silêncio (o sintoma era "importa, mostra a diferença e não baixa
    // nada"), busca as versões desse mod diretamente pelo identificador.
    const url = new URL(`${FORGE_API_BASE}/mods`);
    url.searchParams.set("filter[guid]", info.identifier);
    url.searchParams.set("per_page", "1");
    url.searchParams.set("include", "versions");
    url.searchParams.set("filter[include_legacy]", "true");
    const json = await forgeFetchJson(url.toString(), budget);
    const versions = json?.data?.[0]?.versions;
    const latest = Array.isArray(versions) ? versions[0] : undefined;
    if (latest?.link) {
      out[name] = { downloadLink: latest.link, version: latest.version, forgeName: info.forgeName, guid: info.identifier };
    }
  }
  return out;
}

export async function findForgeDownloadForName(
  name: string,
  sptVersion?: string
): Promise<{ found: boolean; downloadLink?: string; version?: string; forgeName?: string }> {
  // Usa o mesmo matcher multi-estratégia da checagem de atualização, pra que
  // restaurar uma modlist ache tanto quanto ela acha.
  const matches = await matchForgeMods([name]);
  const info = matches.get(name);
  if (!info || !info.latestVersionLink) {
    // Fallback: casamento por nome exato com filtro de versão do SPT aplicado.
    const exact = await findForgeModInfo(name, sptVersion);
    if (!exact || !exact.latestVersionLink) return { found: false };
    return { found: true, downloadLink: exact.latestVersionLink, version: exact.latestVersion, forgeName: exact.forgeName };
  }
  return { found: true, downloadLink: info.latestVersionLink, version: info.latestVersion, forgeName: info.forgeName };
}

export async function checkForgeUpdates(
  mods: { name: string; originalName: string; version?: string; guid?: string }[],
  sptVersion: string,
  onProgress?: (done: number, total: number) => void,
  cacheRoot?: string
): Promise<ForgeUpdateCheckResult> {
  const trimmedVersion = sptVersion.trim();
  if (!trimmedVersion) {
    throw new Error("Informe a versão do SPT antes de verificar atualizações.");
  }

  const pairs: string[] = [];
  const nameByIdentifier = new Map<string, string>();
  const unmatched: string[] = [];
  const skippedByBudget: string[] = [];
  const infoOnly: ForgeUpdateItem[] = [];

  // Resolve TODOS os mods de uma vez (poucas requisições em lote), em vez de uma
  // requisição por mod com pausa entre elas — muito mais rápido e com muito mais
  // chance de achar, já que agora tenta slug/nome/derivado/full-text.
  // Busca pelo nome ORIGINAL (da pasta), não pelo apelido que o usuário deu —
  // assim renomear um mod pra exibição nunca quebra o casamento com a Forge.
  // Versão que lemos do próprio mod, pra descartar "atualização" pra versão já instalada.
  const localVersionByName = new Map<string, string>();
  for (const m of mods) if (m.version) localVersionByName.set(m.name, m.version);

  const matches = await matchForgeMods(
    mods.map((m) => ({ folderName: m.originalName, guid: m.guid })),
    onProgress,
    cacheRoot
  );

  const notChecked = (matches as Map<string, ForgeMatch> & { notChecked?: Set<string> }).notChecked;
  for (const mod of mods) {
    const info = matches.get(mod.originalName);
    if (!info) {
      // Distingue quem não foi consultado (orçamento de requisições esgotado) de quem
      // foi procurado e realmente não está na Forge com esse nome.
      if (notChecked?.has(mod.originalName)) skippedByBudget.push(mod.name);
      else unmatched.push(mod.name);
      continue;
    }
    if (mod.version) {
      // Tem versão local — entra na comparação de verdade contra o Forge.
      pairs.push(`${info.identifier}:${mod.version}`);
      nameByIdentifier.set(info.identifier, mod.name);
    } else if (info.latestVersion) {
      // Sem versão local pra comparar (ex: mod só de .dll, sem package.json) —
      // mostra a versão mais recente conhecida como informação, sem alegar
      // que é "atualização disponível" já que não sabemos a versão instalada.
      infoOnly.push({ name: mod.name, recommendedVersion: info.latestVersion, reason: "no_local_version" });
    } else {
      unmatched.push(mod.name);
    }
  }

  const empty: ForgeUpdateCheckResult = {
    sptVersionUsed: trimmedVersion,
    updates: [],
    blocked: [],
    upToDate: [],
    incompatible: [],
    infoOnly,
    unmatched,
    skippedByBudget
  };
  if (pairs.length === 0) return empty;

  const url = `${FORGE_API_BASE}/mods/updates?mods=${encodeURIComponent(pairs.join(","))}&spt_version=${encodeURIComponent(trimmedVersion)}`;
  let json: any;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    json = await res.json();
    if (!res.ok || json?.success === false) {
      throw new Error(json?.message || `Forge respondeu ${res.status}`);
    }
  } catch (err: any) {
    throw new Error(`Não foi possível consultar o Forge: ${err.message || err}`);
  }

  const data = json.data || {};
  const nameFor = (guid: string, fallback?: string) => nameByIdentifier.get(guid) || fallback || guid;

  return {
    sptVersionUsed: data.spt_version || trimmedVersion,
    updates: (data.updates || [])
      .map((u: any) => ({
        name: nameFor(u.current_version?.guid, u.current_version?.name),
        currentVersion: u.current_version?.version,
        recommendedVersion: u.recommended_version?.version,
        downloadLink: u.recommended_version?.link,
        // Identificador da Forge, pra que atualizar pelo app grave o mesmo GUID e as
        // próximas checagens desse mod não voltem a depender de casamento por nome.
        guid: u.current_version?.guid,
        reason: u.update_reason
      }))
      // A Forge às vezes devolve como "atualização" uma versão igual à instalada (por
      // exemplo, o mesmo número publicado para outra versão do SPT). Anunciar
      // "v1.2.6 disponível" pra quem já está na v1.2.6 é ruído: se o número é o mesmo,
      // não há o que atualizar.
      .filter((u: { name: string; currentVersion?: string; recommendedVersion?: string }) => {
        const norm = (v?: string) => (v ?? "").trim().replace(/^v/i, "");
        if (!norm(u.recommendedVersion)) return true;
        // Compara com a versão da Forge E com a que lemos localmente. A Forge às vezes
        // está desatualizada sobre o que você tem instalado (MakeMedsGreatAgain: ela diz
        // que você está na 1.2.5 e recomenda a 1.2.6, mas a DLL local já é 1.2.6), e
        // anunciar atualização pra versão que a pessoa já tem é ruído.
        const local = localVersionByName.get(u.name);
        if (local && norm(u.recommendedVersion) === norm(local)) return false;
        return norm(u.recommendedVersion) !== norm(u.currentVersion);
      }),
    blocked: (data.blocked_updates || []).map((b: any) => ({
      name: nameFor(b.current_version?.guid, b.current_version?.name),
      currentVersion: b.current_version?.version,
      recommendedVersion: b.latest_version?.version,
      reason: b.block_reason
    })),
    upToDate: (data.up_to_date || []).map((u: any) => ({
      name: nameFor(u.guid, u.name),
      currentVersion: u.version,
      reason: "up_to_date"
    })),
    incompatible: (data.incompatible_with_spt || []).map((i: any) => ({
      name: nameFor(i.guid, i.name),
      currentVersion: i.version,
      reason: i.reason
    })),
    infoOnly,
    unmatched,
    skippedByBudget
  };
}

/* ==========================================================================
 * Busca/navegação de mods no catálogo da Forge + instalação em um clique.
 * Diferente do checkForgeUpdates acima (que compara mods JÁ instalados),
 * essa parte deixa o usuário descobrir mods novos direto no app, sem abrir
 * o navegador.
 * ========================================================================== */

export interface ForgeCatalogVersion {
  id: number;
  version: string;
  sptConstraint?: string;
  link: string;
  downloads: number;
  contentLength?: number;
}

export interface ForgeCatalogMod {
  id: number;
  guid: string;
  name: string;
  slug: string;
  teaser?: string;
  thumbnail?: string;
  downloads: number;
  author?: string;
  category?: string;
  fikaCompatible?: boolean;
  detailUrl?: string;
  versions: ForgeCatalogVersion[];
}

export interface ForgeSearchResult {
  mods: ForgeCatalogMod[];
  page: number;
  lastPage: number;
  total: number;
}

export interface ForgeCategory {
  id: number;
  title: string;
  slug: string;
}

function mapCatalogMod(m: any): ForgeCatalogMod {
  return {
    id: m.id,
    guid: m.guid,
    name: m.name,
    slug: m.slug,
    teaser: m.teaser || undefined,
    thumbnail: m.thumbnail || undefined,
    downloads: m.downloads ?? 0,
    author: m.owner?.name,
    category: m.category?.name,
    fikaCompatible: typeof m.fika_compatibility === "boolean" ? m.fika_compatibility : undefined,
    detailUrl: m.detail_url,
    versions: Array.isArray(m.versions)
      ? m.versions.map((v: any) => ({
          id: v.id,
          version: v.version,
          sptConstraint: v.spt_version_constraint || undefined,
          link: v.link,
          downloads: v.downloads ?? 0,
          contentLength: v.content_length ?? undefined
        }))
      : []
  };
}

// Busca paginada no catálogo da Forge. `query` usa a busca full-text deles
// (Meilisearch, nome/slug/descrição); `sptVersionConstraint` é opcional e
// filtra por compatibilidade (a própria Forge avisa que isso filtra o MOD,
// não necessariamente cada versão individual — por isso ainda mostramos a
// lista de versões recentes de cada mod pro usuário escolher).
export async function searchForgeMods(params: {
  query?: string;
  categorySlug?: string;
  sptVersionConstraint?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}): Promise<ForgeSearchResult> {
  const url = new URL(`${FORGE_API_BASE}/mods`);
  url.searchParams.set("include", "category,versions");
  url.searchParams.set("sort", params.sort || "-downloads");
  url.searchParams.set("page", String(params.page || 1));
  url.searchParams.set("per_page", String(params.perPage || 24));
  if (params.query) url.searchParams.set("query", params.query);
  if (params.categorySlug) url.searchParams.set("filter[category_slug]", params.categorySlug);
  if (params.sptVersionConstraint) url.searchParams.set("filter[spt_version]", params.sptVersionConstraint);

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  const json: any = await res.json();
  if (!res.ok || json?.success === false) {
    throw new Error(json?.message || `Forge respondeu ${res.status}`);
  }

  return {
    mods: (json.data || []).map(mapCatalogMod),
    page: json.meta?.current_page ?? 1,
    lastPage: json.meta?.last_page ?? 1,
    total: json.meta?.total ?? (json.data || []).length
  };
}

export async function getForgeCategories(): Promise<ForgeCategory[]> {
  const url = `${FORGE_API_BASE}/mod-categories?per_page=100&fields=id,title,slug`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const json: any = await res.json();
    return (json?.data || []).map((c: any) => ({ id: c.id, title: c.title, slug: c.slug }));
  } catch {
    return [];
  }
}

// Baixa o arquivo de uma versão de mod da Forge pra uma pasta temporária e
// reaproveita installModFromArchive (mesmo caminho de instalação usado pra
// arquivos escolhidos manualmente). O nome/extensão do arquivo é resolvido
// pelo Content-Disposition quando presente; senão, pela URL; senão, assume
// .zip (formato mais comum na Forge).
export async function installForgeModVersion(
  clientRoot: string,
  serverRoot: string,
  downloadLink: string,
  suggestedName: string,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
  forgeInfo?: ForgeInstallInfo
): Promise<InstallResult> {
  let tmpFilePath: string | undefined;
  try {
    const res = await fetch(downloadLink);
    if (!res.ok) {
      return { success: false, message: `Não foi possível baixar o mod da Forge (HTTP ${res.status}).` };
    }

    let ext = ".zip";
    const disposition = res.headers.get("content-disposition");
    const dispositionMatch = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const dispositionName = dispositionMatch ? decodeURIComponent(dispositionMatch[1]) : undefined;
    const nameToInspect = dispositionName || new URL(downloadLink).pathname;
    const inferredExt = path.extname(nameToInspect).toLowerCase();
    if (inferredExt === ".zip" || inferredExt === ".7z" || inferredExt === ".rar") {
      ext = inferredExt;
    }

    const safeName = suggestedName.replace(/[^a-z0-9._-]/gi, "_").slice(0, 60) || "forge-mod";
    tmpFilePath = path.join(clientRoot, `.tmp-forge-download-${Date.now()}-${safeName}${ext}`);

    // Grava em streaming DIRETO NO DISCO, pedaço a pedaço. Nunca segura o arquivo
    // inteiro na memória: mods de conteúdo passam facilmente de 1 GB, e tanto
    // juntar os pedaços no fim quanto usar arrayBuffer() precisariam do arquivo
    // todo (ou o dobro dele) na RAM — que é o que fazia mod grande falhar.
    const totalBytes = Number(res.headers.get("content-length") || 0);
    const reader = res.body?.getReader();
    if (!reader) {
      return { success: false, message: "Falha ao baixar/instalar da Forge: resposta sem conteúdo." };
    }
    const fileHandle = fs.createWriteStream(tmpFilePath);
    let receivedBytes = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        // Respeita a contrapressão do disco: se o buffer encheu, espera drenar
        // antes de pedir mais dados da rede.
        if (!fileHandle.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => fileHandle.once("drain", () => resolve()));
        }
        receivedBytes += value.byteLength;
        onProgress?.(receivedBytes, totalBytes);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        fileHandle.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }

    return await installModFromArchive(clientRoot, serverRoot, tmpFilePath, suggestedName, forgeInfo);
  } catch (err: any) {
    return { success: false, message: `Falha ao baixar/instalar da Forge: ${err.message || err}` };
  } finally {
    if (tmpFilePath && fs.existsSync(tmpFilePath)) {
      try {
        fs.unlinkSync(tmpFilePath);
      } catch {
        // best-effort — não trava a instalação por causa da limpeza do tmp
      }
    }
  }
}
/* ==========================================================================
 * Checagem de atualização do próprio Mod Manager (via releases do GitHub).
 *
 * Deliberadamente só NOTIFICA — nunca baixa nem instala nada sozinho. Um app
 * que se auto-atualiza é uma classe de risco bem diferente (e a comunidade do
 * SPT, com razão, desconfia de manager que mexe em coisa sozinho). Aqui a
 * gente só avisa que existe versão nova e abre a página do release no
 * navegador se a pessoa quiser.
 * ========================================================================== */

const GITHUB_RELEASES_API = "https://api.github.com/repos/Nevek20/SPT_Mod_Manager/releases/latest";

// A versão vem da API de releases do GitHub (é lá que o número é publicado), mas o
// link que a gente mostra é o da Forge — é de lá que o pessoal do SPT baixa de verdade.
const FORGE_MOD_PAGE = "https://forge.sp-tarkov.com/mod/2851/spt-mod-manager";

export interface AppUpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadPageUrl?: string; // página da Forge — onde a pessoa efetivamente baixa
  releaseUrl?: string; // página do release no GitHub (changelog/código), como link secundário
  releaseName?: string;
}

// Compara duas versões semver numericamente ("0.10.0" > "0.9.0", que a comparação
// de string erraria). Ignora um "v" na frente, que é comum em tag do git.
function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkAppUpdate(currentVersion: string): Promise<AppUpdateInfo> {
  try {
    const res = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "SPT-Mod-Manager" }
    });
    // Falha de rede, rate limit (a API pública do GitHub limita por IP) ou repo sem
    // release ainda: não é erro pro usuário, só não dá pra saber agora. Melhor ficar
    // quieto do que mostrar alarme falso.
    if (!res.ok) return { updateAvailable: false, currentVersion };
    const json: any = await res.json();
    const latestVersion: string | undefined = json?.tag_name;
    if (!latestVersion) return { updateAvailable: false, currentVersion };

    return {
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion: latestVersion.replace(/^v/i, ""),
      downloadPageUrl: FORGE_MOD_PAGE,
      releaseUrl: json?.html_url,
      releaseName: json?.name || undefined
    };
  } catch {
    return { updateAvailable: false, currentVersion };
  }
}