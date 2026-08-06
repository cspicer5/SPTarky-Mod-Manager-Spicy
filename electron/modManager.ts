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

// --- Aliases (custom display name; touches no files at all) ---
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

  // Client mods (disabled)
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

  // "Orphan" mods tracked by manifest (files with no named folder of their own) — they do
  // not support enable/disable, but they appear in the list and can be removed cleanly.
  const manifest = loadManifest(clientRoot);
  // Ids of the "real" mods (with their own folder) already listed above.
  const namedModIds = new Set(mods.map((m) => m.id));
  for (const [manifestId, files] of Object.entries(manifest)) {
    const stillExists = files.some((relPath) => fs.existsSync(resolveManifestFilePath(clientRoot, serverRoot, relPath)));
    if (!stillExists) continue; // files are gone (removed outside the app) — do not show a ghost
    const registryEntry = registry.find((r) => r.id === manifestId);

    // When these loose files came from the same archive as a single named mod, they are
    // not a separate item from the user's point of view — they are part of that mod.
    // Hiding them avoids the duplicated row ("DynamicMaps" + "DynamicMaps-1.1.3"), and
    // removing the mod takes these files with it (see uninstallMod).
    // If the linked mod no longer exists, the orphan REAPPEARS — otherwise it would become
    // an invisible file that the app could never remove.
    const linkedTo = registryEntry?.linkedModIds ?? (registryEntry?.linkedModId ? [registryEntry.linkedModId] : []);
    if (linkedTo.length > 0 && linkedTo.some((id) => namedModIds.has(id))) continue;

    // Implicit link: an orphan sharing a display name with an existing mod is, in
    // practice, leftovers from that mod. This covers installs made before the explicit
    // link existed — without it, they duplicate the mod's row forever.
    const displayName = registryEntry?.displayName;
    if (displayName && namedModIds.has(displayName)) continue;

    // An orphan's name usually comes from the downloaded file, with the version stuck on
    // ("MergeConsumables.1.5.4"), while the mod itself is called "MergeConsumables".
    // Comparing the cleaned forms links the two and drops the duplicate row.
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

  // INFERRED package, for mods already installed before the explicit link existed.
  //
  // The signal: the same folder appearing on both sides (user/mods/Wedge +
  // BepInEx/plugins/Wedge). Mod authors name the folder after the mod, so two DIFFERENT
  // mods sharing an identical folder name is quite unlikely — verified against a real
  // 136-mod installation, where all 8 pairs in this situation were the same mod.
  //
  // The id starts with "inferred:" deliberately: it is a guess, not a record, so it is
  // never written to disk and vanishes if the folder is renamed. If it guesses wrong,
  // undoing it is just a matter of toggling again.
  // The key ignores separators and the suffix denoting the part's ROLE rather than the
  // mod: "MoreBotsServer" + "MoreBotsAPI" -> "morebots"; "MergeConsumablesServer" +
  // "MergeConsumables" -> "mergeconsumables". Verified against 9 real pairs from an actual
  // installation — all grouped correctly, and pairs that are NOT the same mod
  // ("WTT-ServerCommonLib" and "WTT-ClientCommonLib") stayed separate, because only a
  // trailing suffix is stripped.
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
    const distinctTypes = new Set(group.map((m) => m.type));
    if (group.length >= 2 && distinctTypes.size >= 2) {
      for (const mod of group) {
        mod.packageId = `inferred:${key}`;
        // Record the other parts: their names can differ, so the toggle has no way to
        // rediscover them on its own.
        mod.packageSiblings = group
          .filter((other) => !(other.id === mod.id && other.type === mod.type))
          .map((other) => ({ id: other.id, type: other.type }));
      }
    }
  }

  return mods.sort((a, b) => a.loadOrder - b.loadOrder || a.name.localeCompare(b.name));
}

// --- Installing a mod from a .zip or .7z ---
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

    // Case 2: the archive holds loose DLLs or a single folder -> try to tell client from server
    const dllFiles = findFilesRecursive(tmpExtractDir, ".dll");
    const hasPackageJson = findFilesRecursive(tmpExtractDir, "package.json").length > 0;

    let destBase: string;
    let modId: string;
    let type: ModType;

    if (hasPackageJson && dllFiles.length === 0) {
      // Server mod: assume the extracted root (or its single subfolder) is the mod's folder
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
        return { success: false, message: `Incomplete installation: file not confirmed at the destination (${verification.missing}).` };
      }
      type = "server";
    } else if (dllFiles.length > 0) {
      // Client mod: copy the folder (or loose files) into BepInEx/plugins
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
          return { success: false, message: `Incomplete installation: file not confirmed at the destination (${verification.missing}).` };
        }
      } else {
        modId = path.parse(archivePath).name;
        const clientDest = path.join(destBase, modId);
        copyRecursive(tmpExtractDir, clientDest);
        const verification = verifyCopyRecursive(tmpExtractDir, clientDest);
        if (!verification.ok) {
          cleanup(tmpExtractDir);
          return { success: false, message: `Incomplete installation: file not confirmed at the destination (${verification.missing}).` };
        }
      }
      type = "client";
    } else {
      // Unrecognised structure (no DLL, no package.json, no user/BepInEx folder at any
      // level). Rather than rejecting outright, hand the root contents back for the user
      // to decide — deliberately does NOT clean up the temp folder here, so the same
      // extraction can be reused if they choose to continue, instead of making them
      // select the file again.
      const rootEntries = fs
        .readdirSync(tmpExtractDir, { withFileTypes: true })
        .map((e) => e.name + (e.isDirectory() ? "/" : ""));
      return {
        success: false,
        needsConfirmation: true,
        tmpDir: tmpExtractDir,
        rootEntries,
        archivePath,
        message: "Unusual file structure: found no DLL, package.json, or user/BepInEx folder."
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
    return { success: true, message: `Mod "${modId}" installed and verified as a ${type === "server" ? "server mod" : "client mod"}.` };
  } catch (err) {
    cleanup(tmpExtractDir);
    return { success: false, message: "Error while installing: " + (err as Error).message };
  }
}

/**
 * Copies the contents of `mergeRoot` (a folder that already has "user/" and/or "BepInEx/"
 * inside it, whether auto-detected or confirmed by the user for an unusual structure) into
 * the SPT instance, registers each mod found individually, and tracks any "loose" file via
 * the manifest. Shared between the normal install flow and manual confirmation of an
 * unusual structure.
 *
 * When the instance is "split" (clientRoot !== serverRoot), the copy is split too:
 * everything under "user/" goes to serverRoot, and the rest (BepInEx/ and any loose file
 * at the mod's root) goes to clientRoot. On normal instances (the vast majority)
 * clientRoot and serverRoot are the same folder, so this changes nothing in practice.
 */
/**
 * Some mods package the server part inside a wrapper folder (almost always called "SPT"),
 * side by side with a loose BepInEx at the root:
 *
 *   BepInEx/plugins/FooClient/     <- straight at the root
 *   SPT/user/mods/Foo/             <- wrapped
 *
 * Because "BepInEx" exists at the root, findMergeRoot stops there and never descends into
 * the wrapper — so the server part went unrecognised (no registry entry, showing up as
 * "installed manually") and, on a non-split install, was also copied to the wrong place
 * (<root>/SPT/user/mods instead of <root>/user/mods).
 *
 * Here we flatten those wrappers BEFORE merging, moving "user"/"BepInEx" out of them and
 * up to the extraction root. The rest of the logic then works without knowing the wrapper
 * ever existed. This all happens inside the temp folder, so moving is cheap.
 */
function flattenWrapperDirs(mergeRoot: string): void {
  for (const entry of fs.readdirSync(mergeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    if (lower === "user" || lower === "bepinex") continue; // already in the right place

    const wrapperPath = path.join(mergeRoot, entry.name);
    const inner = fs.readdirSync(wrapperPath, { withFileTypes: true });
    const relevant = inner.filter(
      (e) => e.isDirectory() && (e.name.toLowerCase() === "user" || e.name.toLowerCase() === "bepinex")
    );
    if (relevant.length === 0) continue; // not a wrapper — this is the mod's own content

    for (const folder of relevant) {
      const from = path.join(wrapperPath, folder.name);
      const to = path.join(mergeRoot, folder.name);
      if (fs.existsSync(to)) {
        // Already exists at the root (e.g. BepInEx in both places) — merge, don't overwrite.
        copyRecursive(from, to);
        fs.rmSync(from, { recursive: true, force: true });
      } else {
        fs.renameSync(from, to);
      }
    }
    // Drop the wrapper if nothing is left inside it.
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

  // Before copying/cleaning up, record the names of the real mod folders coming in (e.g.
  // "EpicsAIO" inside "user/mods/"), so each can be registered individually afterwards —
  // rather than losing that information the moment the temp folder is deleted.
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
        if (isProtectedClientEntry(entry.name)) continue; // never register SPT's own core as a mod
        if (entry.isDirectory() || entry.name.endsWith(".dll")) clientModNames.push(entry.name);
      }
    }
  }

  // Any file that does not land inside one of those named folders is an "orphan" — e.g.
  // something loose directly in user/ or BepInEx/ outside mods/plugins. We track those
  // paths in a manifest before deleting the temp folder, so the trail is not lost.
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
      // Never track SPT's core: besides not being copied, if it entered the manifest then
      // removing the mod would delete the client's core.
      !isProtectedInstancePath(f)
  );

  // Split copy: "user/" goes to serverRoot, everything else (BepInEx/ and any loose file
  // at the root) goes to clientRoot. When both roots are the same folder, the result is
  // exactly what it always was.
  const userSrc = path.join(mergeRoot, "user");
  if (hasUserFolder) {
    copyRecursive(userSrc, path.join(serverRoot, "user"));
    const verification = verifyCopyRecursive(userSrc, path.join(serverRoot, "user"));
    if (!verification.ok) {
      cleanup(tmpExtractDir);
      return { success: false, message: `Incomplete installation: file not confirmed at the destination (${verification.missing}).` };
    }
  }
  const skippedCoreFiles: string[] = [];
  for (const entry of mergeEntries) {
    if (entry.name.toLowerCase() === "user") continue; // handled above
    const srcPath = path.join(mergeRoot, entry.name);
    const destPath = path.join(clientRoot, entry.name);
    if (entry.isDirectory()) {
      copyRecursiveProtected(srcPath, destPath, entry.name, skippedCoreFiles);
      const verification = verifyCopyRecursive(srcPath, destPath, skippedCoreFiles, entry.name);
      if (!verification.ok) {
        cleanup(tmpExtractDir);
        return { success: false, message: `Incomplete installation: file not confirmed at the destination (${verification.missing}).` };
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

  // Where it can be established with certainty that the loose file(s) belong to a single
  // named mod from this same install (the common case: a stray .cfg beside the plugin's
  // real folder), we link the two — removing one removes the other, so nothing is left
  // behind and the mod is never "broken" by removing only half of it. If there is more
  // than one named mod in the same install, there is no way to tell which it belongs to,
  // so nothing is linked.
  const orphanId = orphanFiles.length > 0 ? "hybrid-manifest-" + Date.now() : undefined;
  // Loose files belong to the PACKAGE, not to one specific mod — a single archive can
  // install both the server and client parts (e.g. mpstark-dynamicmaps + DynamicMaps) and
  // the loose config belongs to both. So every named mod from this same archive points at
  // the loose files, and they only disappear when the LAST of them is removed.
  const allNamedModIds = [...serverModNames, ...clientModNames];

  // All parts coming from this same archive share a package id — that is what allows
  // "Wedge server" and "Wedge client" to be treated as a single mod later on.
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
    // Reinstalling the same mod must not stack up entries: the orphan's id is timestamp
    // based, so every install created another one. Remove earlier ones from the same
    // package before registering the new one.
    const orphanDisplayName = preferredDisplayName ?? path.parse(archivePath).name;
    for (const previous of loadRegistry(clientRoot)) {
      const isSamePackageOrphan =
        previous.id.startsWith("hybrid-manifest-") && previous.displayName === orphanDisplayName;
      if (isSamePackageOrphan) {
        removeManifestEntry(clientRoot, previous.id);
        removeFromRegistry(clientRoot, previous.id);
      }
    }

    // Register as an "orphan" mod tracked by manifest — it has no folder of its own to
    // enable/disable, but at least it shows up in the list and can be removed cleanly.
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
      message: `Mod installed. ${skippedCoreFiles.length} SPT core file(s) shipped inside the package were skipped, to avoid breaking the installation.`
    };
  }
  return { success: true, message: "Mod installed and verified (full structure detected)." };
}

/**
 * Only accepts folders the Manager itself created for temporary extraction in this
 * instance — never an arbitrary path from the renderer process, which is not trusted
 * enough to delete or merge things directly into the SPT instance. Temp folders are always
 * created inside clientRoot (see installModFromArchive above).
 */
function isOwnTempExtractDir(clientRoot: string, tmpDir: string): boolean {
  const resolved = path.resolve(tmpDir);
  const expectedParent = path.resolve(clientRoot);
  return path.dirname(resolved) === expectedParent && path.basename(resolved).startsWith(".tmp-mod-extract-");
}

// Used when the user reviews an unusual file structure and chooses "Continue anyway" —
// reuses the extraction already performed (no re-download, no re-extract) and forces the
// merge straight into the SPT instance.
export function finalizeUnrecognizedInstall(
  clientRoot: string,
  serverRoot: string,
  tmpDir: string,
  archivePath: string,
  preferredDisplayName?: string
): InstallResult {
  if (!isOwnTempExtractDir(clientRoot, tmpDir)) {
    return { success: false, message: "Invalid temporary path." };
  }
  if (!fs.existsSync(tmpDir)) {
    return { success: false, message: "The temporary extraction no longer exists — try installing the file again." };
  }
  return performMerge(clientRoot, serverRoot, tmpDir, archivePath, tmpDir, preferredDisplayName);
}

// Used when the user aborts after reviewing an unusual file structure.
export function discardPendingInstall(clientRoot: string, tmpDir: string): { success: boolean; message: string } {
  if (!isOwnTempExtractDir(clientRoot, tmpDir)) {
    return { success: false, message: "Invalid temporary path." };
  }
  cleanup(tmpDir);
  return { success: true, message: "Installation cancelled." };
}

// --- Enable/disable (moves between the active folder and .disabled) ---
/**
 * Moves a mod's folder between the active folder and .disabled. Returns false when there
 * is nothing to move (absent at the source, or the destination is already occupied).
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

/** The other parts of the same package (e.g. the server half of a client+server mod). */
function findPackageSiblings(clientRoot: string, modId: string, modType: ModType): RegistryEntry[] {
  const registry = loadRegistry(clientRoot);
  const own = registry.find((r) => r.id === modId && r.type === modType);
  if (!own?.packageId) return [];
  // Compare by id + type: Wedge's two halves share an id, and comparing by id alone would
  // discard precisely the other part we want to toggle alongside it.
  return registry.filter(
    (r) => r.packageId === own.packageId && !(r.id === modId && r.type === modType) && !r.id.startsWith("hybrid-manifest-")
  );
}

export function toggleMod(clientRoot: string, serverRoot: string, mod: ModInfo): { success: boolean; message: string } {
  if (mod.type === "client" && isProtectedClientEntry(mod.id)) {
    return { success: false, message: "This item is one of SPT's own files (not a mod) and can't be toggled." };
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
    return { success: false, message: "Mod file/folder not found: " + from };
  }
  fs.renameSync(from, to);

  // The data folder accompanying a loose .dll has to follow the enable/disable too —
  // otherwise the plugin moves and its data is left behind.
  if (!isServer && mod.id.toLowerCase().endsWith(".dll")) {
    const baseName = mod.id.slice(0, -4);
    const companionFrom = path.join(mod.enabled ? activeDir : disabledDir, baseName);
    const companionTo = path.join(mod.enabled ? disabledDir : activeDir, baseName);
    if (fs.existsSync(companionFrom) && fs.statSync(companionFrom).isDirectory() && !fs.existsSync(companionTo)) {
      fs.renameSync(companionFrom, companionTo);
    }
  }

  // Prepatchers from the same mod follow the enable/disable. Without this, disabling Wedge
  // (for example) moved Wedge.Client.dll but left Wedge.Prepatch.dll running.
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

  // The other parts of the same package follow along: a mod with a server half and a
  // client half, only half disabled, usually does not work — and users almost never want
  // that.
  let movedSiblings = 0;
  if (mod.packageId?.startsWith("inferred:")) {
    // Inferred package: the parts can have DIFFERENT names ("MoreBotsServer" and
    // "MoreBotsAPI"), so the scan is what knows which they are — and it already passed the
    // ids on the mod itself. Without this, grouping only worked for identical names.
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
        ? `Mod disabled (${movedSiblings + 1} package parts).`
        : `Mod enabled (${movedSiblings + 1} package parts).`
    };
  }

  if (movedPatchers > 0) {
    return {
      success: true,
      message: mod.enabled
        ? `Mod disabled (along with ${movedPatchers} patcher(s)).`
        : `Mod enabled (along with ${movedPatchers} patcher(s)).`
    };
  }
  return { success: true, message: mod.enabled ? "Mod disabled." : "Mod enabled." };
}

// --- Uninstall ---
export function uninstallMod(clientRoot: string, serverRoot: string, mod: ModInfo): { success: boolean; message: string } {
  if (mod.type === "client" && isProtectedClientEntry(mod.id)) {
    return { success: false, message: "This item is one of SPT's own files (not a mod) and can't be removed by the Manager." };
  }

  // "Orphan" mods (manifestOnly) have no folder of their own named after the mod — they
  // are loose files tracked individually in the manifest. Each listed file has to be
  // deleted, rather than looking for a folder called `mod.id`.
  if (mod.manifestOnly) {
    const manifest = loadManifest(clientRoot);
    const files = manifest[mod.id];
    if (!files || files.length === 0) {
      // The record was already empty/inconsistent — clear the list entry anyway, so no
      // ghost is left that nobody can remove.
      removeManifestEntry(clientRoot, mod.id);
      removeFromRegistry(clientRoot, mod.id, mod.type);
      return { success: true, message: "Entry removed from the list (no tracked files)." };
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
    return { success: true, message: `${removedCount} orphan file(s) removed.` };
  }

  const isServer = mod.type === "server";
  const base = isServer ? serverRoot : clientRoot;
  const dir = p(base, mod.enabled ? (isServer ? SERVER_MODS_DIR : CLIENT_PLUGINS_DIR) : isServer ? SERVER_MODS_DISABLED_DIR : CLIENT_PLUGINS_DISABLED_DIR);
  const target = path.join(dir, mod.id);
  if (!fs.existsSync(target)) {
    return { success: false, message: "Mod not found: " + target };
  }
  fs.rmSync(target, { recursive: true, force: true });

  // The mod's prepatchers go too — from both folders, since the mod may be disabled at the
  // moment it is removed.
  if (!isServer) {
    for (const patchersDir of [p(clientRoot, CLIENT_PATCHERS_DIR), p(clientRoot, CLIENT_PATCHERS_DISABLED_DIR)]) {
      for (const filePath of findRelatedPatcherFiles(patchersDir, mod.id)) {
        // Can be a file OR a folder: some mods put their patchers in a subfolder
        // (BepInEx/patchers/Wedge/), so removal has to be recursive.
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }
  }

  // A loose client mod (.dll) usually has a same-named data folder beside it — that folder
  // is not listed as a mod (it is the mod's data), so it has to go too.
  if (!isServer && mod.id.toLowerCase().endsWith(".dll")) {
    const companion = path.join(dir, mod.id.slice(0, -4));
    if (fs.existsSync(companion) && fs.statSync(companion).isDirectory()) {
      fs.rmSync(companion, { recursive: true, force: true });
    }
  }

  // Also removes the loose files that came in this mod's own archive. They do not appear
  // as a separate item in the list (see scanMods), so they have to go with it — otherwise
  // they would become true orphans: unowned and impossible to remove.
  const registryAfter = loadRegistry(clientRoot);
  const registryEntry = registryAfter.find((r) => r.id === mod.id);
  let linkedFilesRemoved = 0;
  // Only removes the package's files when no other mod from the same archive is still
  // installed — otherwise it would delete the config of a mod that is still there.
  const orphanEntry =
    (registryEntry?.linkedModId ? registryAfter.find((r) => r.id === registryEntry.linkedModId) : undefined) ??
    // Implicit link (see scanMods): an orphan sharing this mod's display name.
    registryAfter.find((r) => r.id.startsWith("hybrid-manifest-") && r.displayName === mod.id);
  // A "sibling" can be of another type (the package installs both server and client), and
  // can be enabled or disabled — hence checking all four combinations.
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
        ? `Mod removed (along with ${linkedFilesRemoved} file(s) that shipped with it).`
        : "Mod removed."
  };
}

// --- Filesystem helpers ---
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
 * Like copyRecursive, but never writes over SPT's client core. `relPrefix` is the path
 * walked so far from the instance root, so protection is decided on the full path (not
 * just the filename). Returns what was skipped, so the installer can say so.
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
 * Some mods ship with a "wrapper" folder at the top of the zip (e.g. "SPT/user/mods/ModName"
 * instead of "user/mods/ModName" at the root — common when whoever packaged the mod simply
 * zipped their own instance folder). This searches recursively (down a few levels) for a
 * folder that has "user" and/or "BepInEx" as direct children, rather than looking only at
 * the shallowest level of the extracted zip.
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
 * Checks, file by file, that everything present in src also exists in dest (same size).
 * Used to confirm an installation genuinely finished, rather than assuming copyRecursive
 * did not fail silently.
 */
function verifyCopyRecursive(
  src: string,
  dest: string,
  // Files deliberately not copied (SPT core that shipped inside the package) — without
  // this, verification would report "incomplete installation" for something we chose to
  // skip on purpose.
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
 * Integration with the Forge API (forge.sp-tarkov.com) — SPT's official mod
 * platform. Public, read-only, no key required; the API is documented as open
 * and does not support authentication at all, so there is no "logged in" mode
 * that would raise the limits. Documented limits: 40 requests/10s burst and
 * 200/60s sustained — which is why the name lookups below run one at a time
 * with an interval between them instead of firing all at once.
 * ========================================================================== */

const FORGE_API_BASE = "https://forge.sp-tarkov.com/api/v0";

export interface ForgeUpdateItem {
  name: string;
  currentVersion?: string;
  recommendedVersion?: string;
  downloadLink?: string;
  guid?: string; // Forge identifier, recorded when the app performs an update
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
  skippedByBudget?: string[]; // never queried: the request budget ran out first
}

export interface ForgeSptVersion {
  version: string;
  modCount: number;
}

// The list of SPT versions Forge itself knows about — used to build a picker instead of
// relying on free-text entry (avoids typos and invalid versions).
export async function getForgeSptVersions(): Promise<ForgeSptVersion[]> {
  // The API does not accept version_major/minor/patch as a SORT parameter (only as data
  // fields) — sorting by the "version" string would put "3.9.0" after "3.10.0"
  // (alphabetical, not numeric). So we request the separate numbers and sort properly here.
  //
  // Endpoint path verified against the live API: /spt/versions returns 200 with real data.
  // (The published docs list this as /spt-versions; that path does not answer. Trust this
  // one — it is what actually works.)
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

/* --------------------------------------------------------------------------
 * Matching an installed mod -> a mod on Forge.
 *
 * Strategies, most reliable first. Each match records HOW it was made (see
 * ForgeMatchMethod), because a wrong match is worse than no match at all: besides
 * showing a bogus "update available", the modlist restorer uses this same mapping to
 * download automatically — so matching wrong would install the wrong mod.
 *
 *   1. manual      — the user pinned this folder to a Forge id. Final; never overridden.
 *   2. guid        — the mod's declared GUID equals the published guid. Unambiguous, and
 *                    batchable: filter[guid] takes a comma-separated list, so dozens of
 *                    mods resolve in one request.
 *   3. cached-id   — a numeric id resolved by an earlier run, re-validated now.
 *   4. name        — the published name matches exactly, or the author confirms it.
 *   5. fuzzy       — full-text search plus a plausibility check. THIS IS A GUESS: it is
 *                    flagged for confirmation and deliberately never cached.
 *
 * Folder names almost never equal the published Forge name, which is why name matching
 * alone fails for most mods:
 *   "DrakiaXYZ-BigBrain"                -> "BigBrain"
 *   "unbreakableKeys"                   -> "Unbreakable keys"
 *   "acidphantasm-bosseshavelegamedals" -> "Bosses Have Lega Medals"
 *
 * include=versions rides along on these queries so the latest known version arrives in
 * the same call — useful for mods with no readable local version (e.g. pure .dll mods
 * with no package.json, like SVM), where no comparison is possible but we can still show
 * "this is the newest version Forge knows about".
 *
 * NOTE: an earlier version of this comment claimed we "only store the NAME locally, not
 * an ID/GUID". That has not been true for a while — mods declare GUIDs (SPT 4.0), Forge
 * gives us one at install time, and the match cache stores the numeric id. It also listed
 * slug-based strategies that were since removed: Forge's slug is derived from the
 * PUBLISHED name, which is precisely what we do not know.
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

// Reduces to a comparable form: letters and digits only, lowercase. Used to verify that a
// Forge result genuinely corresponds to what we asked for.
function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitAuthorPrefix(name: string): { author?: string; rest: string } {
  // The dot is as common as the hyphen as an author separator: in a real installation, 16
  // mods failed to match for this reason alone (Tyfon.UIFixes, IcyClawz.ItemAttributeFix,
  // Kat.BetterAmmoLoadingList, Tosox.DynamicItemWeights, ...).
  const match = /^([A-Za-z0-9]+)[-_.](.+)$/.exec(name);
  // The remainder must contain a letter: otherwise "SAIN.4.4.3" would become author "SAIN"
  // plus name "4.4.3", and the version suffix would be treated as the mod's name.
  if (match && match[2].length >= 3 && /[a-zA-Z]/.test(match[2])) {
    return { author: match[1], rest: match[2] };
  }
  return { rest: name };
}

/**
 * A folder named after the mod's GUID ("com.swiftxp.spt.showmethemoney"). The last segment
 * is usually the name, and the second is the author — which serves as a cross-check.
 */
function splitGuidLikeFolder(name: string): { author?: string; rest?: string } {
  const parts = name.split(".");
  if (parts.length < 3) return {};
  if (!/^(com|org|net|me|xyz|io|dev)$/i.test(parts[0])) return {};
  return { author: parts[1], rest: parts[parts.length - 1] };
}

interface MatchCandidates {
  strictSlugs: string[]; // derived from the FULL folder name — high confidence
  strictNames: string[];
  looseSlugs: string[]; // author prefix stripped — these need verification
  looseNames: string[];
  authorHint?: string;
}

/**
 * Strips from the folder name whatever is not part of the mod's name on Forge. Patterns
 * observed in a real 136-mod installation, all of which failed to match before this:
 *
 *   "WTT-PackNStrap-2.0.4"        -> "WTT-PackNStrap"    (version appended to the folder)
 *   "SAIN.4.4.3"                  -> "SAIN"
 *   "MedicalAttention-Client"     -> "MedicalAttention"  (client half of a package)
 *   "MergeConsumablesServer"      -> "MergeConsumables"
 *   "[SVM] Server Value Modifier" -> "Server Value Modifier"
 */
function stripFolderNameNoise(name: string): string[] {
  const variants = new Set<string>([name]);
  let current = name;

  // "[SVM] Name" -> "Name"
  const withoutTag = current.replace(/^\[[^\]]+\]\s*/, "").trim();
  if (withoutTag && withoutTag !== current) {
    variants.add(withoutTag);
    current = withoutTag;
  }

  // version suffix: "-2.0.4", ".4.4.3", "_1.2"
  const withoutVersion = current.replace(/[-._]v?\d+(\.\d+){1,3}$/i, "").trim();
  if (withoutVersion && withoutVersion !== current) {
    variants.add(withoutVersion);
    current = withoutVersion;
  }

  // package-part suffix: "-Client", "Server", ".Net"
  const withoutPart = current.replace(/[-._]?(client|server|\.net)$/i, "").trim();
  if (withoutPart && withoutPart.length >= 3 && withoutPart !== current) {
    variants.add(withoutPart);
  }

  return [...variants].filter(Boolean);
}

function buildMatchCandidates(folderName: string): MatchCandidates {
  const { cleanName } = stripLoadOrderPrefix(folderName); // ignores the "01_" on legacy folders
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
  // At most a couple of name attempts per mod: the cleanest first (most likely to match
  // the published name) and the raw form as a fallback. More than that multiplies requests
  // without proportional gain, and the budget is tight.
  const orderedVariants = [...cleanVariants].sort((a, b) => a.length - b.length);
  const strictNames = [...new Set(orderedVariants.flatMap((v) => [v, spaced(v)]))]
    // A variant with no letters at all ("4 4 3") will never match a mod name — it would
    // only burn a request from the budget.
    .filter((v) => v && /[a-zA-Z]/.test(v))
    .slice(0, 3);
  const looseSlugs =
    rest !== cleanName ? [...new Set([slugifyName(rest)])].filter(Boolean) : [];
  // Spaced form first: the published name almost always has spaces ("UI Fixes", "Dynamic
  // Item Weights") rather than camelCase.
  // The author-stripped name also needs the cleanup pass: "Tyfon.UIFixes.Server" leaves
  // "UIFixes.Server", and what we actually want is "UI Fixes".
  const looseRaw = guidLike.rest ?? (rest !== cleanName ? rest : undefined);
  const looseBase = looseRaw ? (stripFolderNameNoise(looseRaw).sort((a, b) => a.length - b.length)[0] ?? looseRaw) : undefined;
  const looseNames = looseBase
    ? [...new Set([spaced(looseBase), looseBase])].filter((v) => v && /[a-zA-Z]/.test(v))
    : [];

  // On a GUID-style folder ("com.swiftxp.spt.showmethemoney") the naive split would take
  // "com" as the author — the real author is the second segment.
  return { strictSlugs, strictNames, looseSlugs, looseNames, authorHint: guidLike.author ?? author };
}

/**
 * A "loose" match (author prefix stripped, or found via full-text search) only counts if
 * it can be confirmed some other way: either the Forge author matches the prefix we took
 * from the folder name, or the published name contains what we searched for.
 */
function isPlausibleMatch(candidate: any, searched: string, authorHint?: string): boolean {
  const rawName = String(candidate?.name ?? "");
  // The PUBLISHED name can carry a bracketed prefix too ("[SAIN] Twitch Players"), so the
  // comparison has to consider both forms on both sides.
  const rawNameNoTag = rawName.replace(/^\[[^\]]+\]\s*/, "").trim();
  const rawSlug = String(candidate?.slug ?? "");
  const forgeName = normalizeForCompare(rawName);
  const forgeSlug = normalizeForCompare(rawSlug);
  const forgeOwner = normalizeForCompare(String(candidate?.owner?.name ?? ""));
  const target = normalizeForCompare(searched);
  if (!target) return false;

  // 1) Equality — the ideal case.
  if (forgeSlug === target || forgeName === target) return true;

  // 2) Author agrees — strong enough even when the name differs.
  if (authorHint && forgeOwner && forgeOwner === normalizeForCompare(authorHint)) return true;

  // 3) Published name starts with what we searched for, ending at a word boundary.
  //    Covers the VERY common case of Forge using a long title while the folder uses the
  //    short name: "SAIN" -> "SAIN - Solarint's AI Modifications - ...".
  //    The word boundary stops "keys" matching "KeysReworked": we require that whatever
  //    follows in the ORIGINAL name is not alphanumeric.
  if (normalizeForCompare(rawNameNoTag) === target) return true;
  if (target.length >= 3 && startsWithAtWordBoundary(rawName, searched)) return true;
  if (target.length >= 3 && rawNameNoTag !== rawName && startsWithAtWordBoundary(rawNameNoTag, searched)) return true;
  if (target.length >= 3 && startsWithAtWordBoundary(rawSlug, searched)) return true;

  return false;
}

/**
 * "SAIN - Solarint's..." starts with "SAIN" followed by a space -> true.
 * "KeysReworked" starts with "Keys" followed by "R" (a letter) -> false.
 * The comparison ignores case and punctuation within the compared span, but requires the
 * character immediately after it to be a genuine separator.
 */
function startsWithAtWordBoundary(fullValue: string, prefix: string): boolean {
  const normalizedPrefix = normalizeForCompare(prefix);
  if (!normalizedPrefix) return false;
  let consumed = 0;
  let matchedChars = 0;
  for (const char of fullValue) {
    const isAlphaNum = /[a-zA-Z0-9]/.test(char);
    if (isAlphaNum) {
      if (matchedChars >= normalizedPrefix.length) return false; // still inside a word -> not a boundary
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
 * HOW the match was made. This is not telemetry: a WRONG match is worse than none at all,
 * because the modlist restorer downloads and installs using this same mapping — matching
 * wrong installs the wrong mod over the top of yours.
 *
 * Verified against a real 53-mod installation, in the cache the previous version produced:
 *   "Fika"                -> "Fika Headless Launcher"      (a different mod, different author)
 *   "fika-server"         -> "Server Value Modifier [SVM]" (SVM's guid is
 *                            "fika.ghostfenixx.svm" — it starts with "fika", and the name
 *                            search took the bait)
 *   "WTT-ContentBackport" -> "Content Backport - Prestiges" (similar mod, different author)
 * None of these looked suspicious on screen: a bad guess was indistinguishable from a hit.
 * Recording the method is what lets the UI say "confirm this" instead of lying.
 */
type ForgeMatchMethod =
  | "manual" // the user pinned this mod to a Forge id by hand — never overwrite
  | "guid" // GUID declared by the mod == published guid. No ambiguity possible.
  | "cached-id" // numeric id from an earlier check, re-validated now
  | "name" // published name identical to what we searched for
  | "fuzzy"; // full-text search + plausibility — THIS IS A GUESS and may be wrong

/** Only "fuzzy" needs human confirmation; everything else is verifiable. */
function methodNeedsConfirmation(method: ForgeMatchMethod): boolean {
  return method === "fuzzy";
}

interface ForgeMatch {
  identifier: string;
  modId: number; // Forge's numeric id — always present, even when guid is null
  latestVersion?: string;
  latestVersionLink?: string;
  forgeName?: string;
  /** Kept for compatibility with the rest of the code/UI that already reads this field. */
  confidence: "exact" | "derived";
  method: ForgeMatchMethod;
  /** true = show as "needs confirmation" rather than asserting a match. */
  needsConfirmation: boolean;
  /** The guid published on Forge, when present — used to confirm the match. */
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

/* Documented Forge API limits: 40 req/10s (burst) and 200 req/60s (sustained).
 * 40/10s = one request every 250ms at best; we use 320ms of headroom to stay off the
 * limit (it was 120ms before, giving ~83 req/10s — double what is allowed, which is why
 * the check fell into a 429 -> wait -> 429 loop that looked like a hang).
 * These limits are real: probing the API hard enough during development earned a
 * Cloudflare 403 for the whole IP, not just a 429. */
const FORGE_MIN_REQUEST_INTERVAL_MS = 320;
let lastForgeRequestAt = 0;

async function forgeRateLimitGate(): Promise<void> {
  const since = Date.now() - lastForgeRequestAt;
  if (since < FORGE_MIN_REQUEST_INTERVAL_MS) {
    await delay(FORGE_MIN_REQUEST_INTERVAL_MS - since);
  }
  lastForgeRequestAt = Date.now();
}

// Per-run state: a request ceiling and a 429 counter, to guarantee the operation ALWAYS
// finishes in predictable time instead of retrying forever.
interface ForgeBudget {
  remaining: number;
  rateLimitHits: number;
  aborted: boolean;
}

function newForgeBudget(modCount: number): ForgeBudget {
  // Roughly a handful of attempts per mod, with a floor and a ceiling. The old ceiling of
  // 160 silently truncated large installations: with 118 mods the search stopped halfway
  // and the rest were reported as "not found" without ever having been queried.
  // The headroom matters: with the budget exactly at the limit, a mod that uses every
  // attempt pushes another out, and the one pushed out shows as "not found" despite never
  // having been looked up.
  //
  // Since the include_legacy fix (see below) most mods resolve in the batched guid/id
  // queries — one request per 25 mods — so this ceiling is now rarely approached at all.
  return { remaining: Math.min(Math.max(modCount * 7, 30), 1400), rateLimitHits: 0, aborted: false };
}

/**
 * A Forge request respecting the rate limit, the budget, and 429 (with Retry-After).
 * Returns null on any failure — the caller carries on without breaking the whole check.
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
      // If we keep hitting the limit, giving up beats insisting: the docs treat evading
      // the limit as hostile behaviour, and users prefer a quick partial result over a
      // "Checking..." screen frozen for minutes.
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