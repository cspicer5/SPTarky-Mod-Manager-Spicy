/**
 * Reinstall every installed mod at the latest version for a chosen SPT version.
 *
 * Two reasons to want this, and the second is the interesting one:
 *
 *   1. Moving an install to a new SPT version without hand-fetching 50 mods.
 *   2. Capturing REAL versions. A mod's declared version is not evidence of which build you
 *      have — Fika's server mod says 2.0.9 whichever one is installed — and the app only
 *      learns the truth at download time. Mods installed before that recording existed, or
 *      dropped in by hand, have no record at all: 39 of 39 on the reference install. A
 *      reinstall is the only way to give them one.
 *
 * This is the most destructive operation in the app, so it is built defensively:
 *
 *   - configuration is backed up BEFORE anything is downloaded, and restored afterwards.
 *     27 .cfg files and a SAIN preset on the reference install had been edited that same
 *     day; silently resetting those would be worse than the problem this solves.
 *   - each mod's existing folder is kept until its replacement verifies, so a failed
 *     download leaves the old version in place rather than a hole.
 *   - a mod that cannot be resolved is SKIPPED, never removed. "I could not find it" must
 *     not turn into "so I deleted yours".
 *   - the run continues past failures and reports them, because stopping halfway through 54
 *     mods is its own kind of broken.
 */
import fs from "fs";
import path from "path";
import { ModInfo } from "./types";

export interface BulkReinstallProgress {
  phase: "backup" | "resolve" | "install" | "restore" | "done";
  done: number;
  total: number;
  current?: string;
  message?: string;
}

export interface BulkReinstallOutcome {
  name: string;
  status: "reinstalled" | "not-found" | "failed" | "skipped";
  fromVersion?: string;
  toVersion?: string;
  detail?: string;
}

export interface BulkReinstallResult {
  success: boolean;
  message: string;
  backupDir?: string;
  outcomes: BulkReinstallOutcome[];
  counts: { reinstalled: number; notFound: number; failed: number; skipped: number };
}

/**
 * Files worth preserving across a reinstall.
 *
 * Config lives in three places and only one of them is obvious:
 *   - BepInEx/config/*.cfg           — the standard location
 *   - inside the plugin folder       — SAIN keeps presets in SAIN/Presets, Donuts in
 *                                      dvize.Donuts/Config; a folder reinstall wipes these
 *   - inside a server mod's folder   — user/mods/<mod>/config
 */
export function collectConfigPaths(clientRoot: string, serverRoot: string): string[] {
  // Deduplicated case-insensitively. Windows resolves "Presets" and "presets" to the SAME
  // directory, so probing both names found every in-plugin config folder twice — which
  // copied and counted it twice.
  const seen = new Set<string>();
  const found: string[] = [];
  const add = (dir: string) => {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(dir);
  };

  add(path.join(clientRoot, "BepInEx", "config"));

  const scanForConfig = (base: string) => {
    if (!fs.existsSync(base)) return;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modDir = path.join(base, entry.name);
      // Read the real directory names rather than probing candidates, so the actual casing
      // on disk is what gets recorded.
      for (const child of fs.readdirSync(modDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        if (/^(config|presets)$/i.test(child.name)) add(path.join(modDir, child.name));
      }
    }
  };

  scanForConfig(path.join(clientRoot, "BepInEx", "plugins"));
  scanForConfig(path.join(serverRoot, "user", "mods"));

  return found;
}

function copyTree(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Copies every config directory into a timestamped backup beside the install, preserving the
 * path relative to the instance so it can be put back exactly.
 */
interface BackupManifestEntry {
  /** "client" or "server" — which root `rel` is relative to. */
  base: "client" | "server";
  /** The config directory, relative to that root. */
  rel: string;
}

export function backupConfigs(clientRoot: string, serverRoot: string): { dir: string; files: number } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(clientRoot, `.spt-mod-manager-config-backup-${stamp}`);
  const entries: BackupManifestEntry[] = [];
  let files = 0;

  for (const configDir of collectConfigPaths(clientRoot, serverRoot)) {
    // Relative to whichever root it came from, so restoring puts it back in the right place.
    // On a non-split install both roots are the same path and "client" is the right answer.
    const fromServer = configDir.startsWith(serverRoot) && !configDir.startsWith(clientRoot);
    const base = fromServer ? serverRoot : clientRoot;
    const rel = path.relative(base, configDir);
    const target = path.join(dir, fromServer ? "__server__" : "__client__", rel);
    copyTree(configDir, target);
    files += countFiles(target);
    entries.push({ base: fromServer ? "server" : "client", rel });
  }

  // Recorded explicitly so restoring knows what each directory WAS, rather than having to
  // infer it from the tree — which is what led to config being dropped when a reinstalled
  // mod folder did not yet contain its config subdirectory.
  fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify({ entries }, null, 2), "utf-8");

  return { dir, files };
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

/**
 * Puts backed-up config back.
 *
 * Only writes files whose destination directory still exists — if a mod is no longer
 * installed, restoring its config would recreate a folder for a mod that is not there.
 */
export function restoreConfigs(clientRoot: string, serverRoot: string, backupDir: string): number {
  if (!fs.existsSync(backupDir)) return 0;

  let manifest: { entries: BackupManifestEntry[] };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "backup.json"), "utf-8"));
  } catch {
    return 0;
  }

  let restored = 0;

  const copyInto = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) {
        copyInto(src, dest);
        continue;
      }
      try {
        fs.copyFileSync(src, dest);
        restored++;
      } catch {
        /* one unreadable file must not abort the whole restore */
      }
    }
  };

  for (const entry of manifest.entries) {
    const root = entry.base === "server" ? serverRoot : clientRoot;
    const source = path.join(backupDir, entry.base === "server" ? "__server__" : "__client__", entry.rel);
    if (!fs.existsSync(source)) continue;

    const target = path.join(root, entry.rel);
    // The test is whether the config directory's OWNER still exists — the mod folder, or
    // BepInEx itself. Testing the config directory instead meant a freshly reinstalled mod
    // that did not yet contain its config subfolder was skipped, throwing away exactly the
    // settings this is here to protect. The subfolder is recreated; a mod that is genuinely
    // gone still gets nothing, because its owner is gone too.
    if (!fs.existsSync(path.dirname(target))) continue;

    copyInto(source, target);
  }

  return restored;
}

/** Mods eligible for a bulk reinstall: real, installed mods with a folder of their own. */
export function reinstallableMods(mods: ModInfo[]): ModInfo[] {
  return mods.filter((m) => !m.manifestOnly);
}
