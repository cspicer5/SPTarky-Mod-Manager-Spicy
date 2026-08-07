import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import Store from "electron-store";
import {
  resolveSptInstance,
  scanMods,
  installModFromArchive,
  toggleMod,
  uninstallMod,
  setModAlias,
  resolveModPath,
  exportModListData,
  compareModList,
  detectConflicts,
  detectSptVersion,
  detectSptSemver,
  checkSptCompatibility,
  checkForgeUpdates,
  getForgeSptVersions,
  searchForgeMods,
  getForgeCategories,
  installForgeModVersion,
  findForgeDownloadForName,
  findForgeDownloadsForNames,
  checkAppUpdate,
  finalizeUnrecognizedInstall,
  discardPendingInstall,
  setManualForgeMatch,
  clearManualForgeMatch,
  dismissForgeUpdate,
  undismissForgeUpdate,
  copyClientModToHeadless,
  removeModFromHeadless
} from "./modManager";
import {
  resolveHeadlessInstance,
  describeHeadlessRejection,
  buildParityReport,
  classifyForHeadless,
  buildServerCounterpartIndex,
  forgeHintsFor,
  normaliseModKey,
  parityKey,
  HeadlessClass
} from "./headless";
import { fetchServerSnapshot, buildServerSyncReport, normaliseServerUrl } from "./sptServer";
import { listAppReleases, prepareUpdate } from "./selfUpdate";
import {
  listPresets,
  readPreset,
  createPreset,
  updatePreset,
  renamePreset,
  deletePreset,
  buildPresetReport,
  PresetAddon
} from "./presets";
import {
  getStoreStatus,
  initStore,
  setWritePolicy,
  publishPreset,
  unpublishPreset,
  importPreset,
  readStorePreset,
  exportPresetToFile,
  importPresetFromFile,
  presetFileName,
  publishPresetWithPayloads,
  applyPresetPayloads,
  payloadKeysInUse,
  WritePolicy
} from "./presetStore";
import { storeUsage, verifyPayload, collectOrphanPayloads, formatBytes } from "./presetPayloads";
import {
  backupConfigs,
  restoreConfigs,
  collectConfigPaths,
  reinstallableMods,
  BulkReinstallProgress,
  BulkReinstallOutcome
} from "./bulkReinstall";
import { listGithubReleases, loadInstanceSources, fetchLatestGithubRelease, loadHarvest } from "./modSources";
import {
  loadAddonCatalogue,
  suggestAddons,
  pickAddonVersionForParent,
  detectAddonLinks,
  findKnownIntegrations,
  markInstalledAsAddon,
  clearAddonMark,
  loadAddonLedger,
  recordAddonInstall,
  forgetAddon,
  snapshotVersions,
  restoreClobberedVersions,
  addonsNeedingReinstall
} from "./addons";
import { InstanceConfig, InstanceId, ModInfo, ModType } from "./types";

const MOD_HUB_URL = "https://hub.sp-tarkov.com/";

const store = new Store<InstanceConfig>({
  defaults: {
    sptPath: null,
    serverRoot: null,
    headlessPath: null,
    headlessOverrides: null,
    serverUrl: null,
    sptVersionOverride: null,
    forgeStatusCache: null,
    forgeCheckedAt: null,
    presetStorePath: null,
    presetIdentity: null,
    addonLinks: null
  }
});

// The stored sptPath is always the CLIENT root. serverRoot equals sptPath in the vast
// majority of instances; it only differs on a "split" install (the SPT 4.x installer can
// create a separate subfolder for the server). The fallback here covers configs saved
// before that change, where serverRoot was never set.
function getServerRoot(): string | null {
  return store.get("serverRoot") || store.get("sptPath");
}

/**
 * Resolves the roots an operation should act on.
 *
 * The headless instance deliberately reports the SAME path for client and server. It has no
 * server of its own — it shares the main instance's. Pointing serverRoot at the headless
 * root means a scan will surface any server mods that were copied in there by mistake,
 * which is worth showing precisely because nothing else ever will: they sit in a folder
 * that looks correct and are silently never loaded.
 */
function rootsFor(target: InstanceId | undefined): { clientRoot: string; serverRoot: string } | null {
  if (target === "headless") {
    const headlessPath = store.get("headlessPath");
    return headlessPath ? { clientRoot: headlessPath, serverRoot: headlessPath } : null;
  }
  const sptPath = store.get("sptPath");
  return sptPath ? { clientRoot: sptPath, serverRoot: getServerRoot()! } : null;
}

function scanInstance(target: InstanceId): ModInfo[] {
  const roots = rootsFor(target);
  if (!roots) return [];
  const instanceVersion = store.get("sptVersionOverride") ?? detectSptSemver(roots.clientRoot);
  // Where each mod's code lives, derived from the Forge match cache plus the pre-shutdown
  // harvest. Attached here rather than stored, so it stays correct without a migration and
  // covers mods installed by hand too. This is what makes update checking possible after
  // Forge is gone: GitHub's releases API needs no auth, only the repository.
  const sources = loadInstanceSources(roots.clientRoot);
  return scanMods(roots.clientRoot, roots.serverRoot).map((mod) => {
    const source = sources[mod.id] ?? sources[mod.originalName];
    return {
      ...mod,
      sptCompatibility: checkSptCompatibility(mod.sptVersion, instanceVersion ?? undefined),
      sourceUrl: source?.url,
      sourceRepo: source?.repo
    };
  });
}

function headlessOverrides(): Record<string, HeadlessClass> {
  return (store.get("headlessOverrides") ?? {}) as Record<string, HeadlessClass>;
}

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// --- IPC: instance configuration ---
ipcMain.handle("get-spt-path", () => {
  const path = store.get("sptPath");
  if (!path) return null;
  const serverRoot = getServerRoot()!;
  return { path, serverRoot, split: serverRoot !== path };
});

ipcMain.handle("open-mod-hub", () => {
  shell.openExternal(MOD_HUB_URL);
});

ipcMain.handle("select-spt-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return { success: false };

  const chosen = result.filePaths[0];
  const resolved = resolveSptInstance(chosen);
  if (!resolved) {
    return {
      success: false,
      message: "No SPT instance found in that folder or its immediate subfolders. Select the folder containing SPT.Server.exe."
    };
  }
  store.set("sptPath", resolved.instance.clientRoot);
  store.set("serverRoot", resolved.instance.serverRoot);
  return {
    success: true,
    path: resolved.instance.clientRoot,
    serverRoot: resolved.instance.serverRoot,
    split: resolved.instance.split,
    message: resolved.autoDetected
      ? resolved.instance.split
        ? `Split instance detected — client at "${resolved.instance.clientRoot}", server at "${resolved.instance.serverRoot}".`
        : `Instance found automatically at: ${resolved.instance.clientRoot}`
      : undefined
  };
});

// --- IPC: mods ---
// Compatibility is computed in scanInstance (not during the scan itself) because it depends
// on the SPT version CHOSEN by the user, which the backend only knows via the store.
ipcMain.handle("scan-mods", (_event, target: InstanceId = "main") => scanInstance(target));

/* --- IPC: headless instance ------------------------------------------------
 * A headless client is a second SPT+Fika CLIENT that hosts raids. It shares the main
 * instance's server, so it has no server side of its own — see electron/headless.ts.
 */
ipcMain.handle("get-headless-path", () => store.get("headlessPath"));

ipcMain.handle("select-headless-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return { success: false };

  const chosen = result.filePaths[0];
  const resolved = resolveHeadlessInstance(chosen);
  if (!resolved) {
    return { success: false, message: describeHeadlessRejection(chosen) };
  }
  // Refusing to point both instances at the same folder. Otherwise the app would compare a
  // folder with itself, report flawless parity, and imply a headless client is set up when
  // nothing is actually hosting.
  if (store.get("sptPath") && path.resolve(resolved.instance.root) === path.resolve(store.get("sptPath")!)) {
    return { success: false, message: "That is your main SPT install. The headless client must be a separate install." };
  }
  store.set("headlessPath", resolved.instance.root);
  return {
    success: true,
    path: resolved.instance.root,
    message: resolved.autoDetected ? `Headless client found at: ${resolved.instance.root}` : undefined
  };
});

ipcMain.handle("clear-headless-path", () => {
  store.set("headlessPath", null);
  return { success: true };
});

/**
 * The dual-instance view in one call: both mod lists plus the reconciliation between them.
 * Returned together so the two panels can never render from different scans of the disk.
 */
ipcMain.handle("get-headless-view", () => {
  const headlessPath = store.get("headlessPath");
  if (!headlessPath) return { configured: false };

  const mainMods = scanInstance("main");
  const headlessMods = scanInstance("headless");
  const report = buildParityReport(mainMods, headlessMods, {
    manual: headlessOverrides(),
    forge: { ...forgeHintsFor(mainMods), ...forgeHintsFor(headlessMods) }
  });

  return {
    configured: true,
    headlessPath,
    mainMods,
    headlessMods,
    parity: report
  };
});

/**
 * Classifies the main instance's mods for headless suitability WITHOUT a headless install
 * configured — so the guidance is useful before anyone sets one up.
 */
ipcMain.handle("get-headless-advice", () => {
  const mainMods = scanInstance("main");
  const serverCounterparts = buildServerCounterpartIndex(mainMods);
  const hints = forgeHintsFor(mainMods);
  const manual = headlessOverrides();
  return mainMods.map((mod) => ({
    id: mod.id,
    verdict: classifyForHeadless(mod, {
      manual: manual[normaliseModKey(mod.id)],
      forge: hints[normaliseModKey(mod.id)],
      serverCounterparts
    })
  }));
});

/* --- IPC: installing from GitHub --------------------------------------------
 * The route that outlives Forge. Paste a repository, pick a release, install it — and the
 * release tag becomes the recorded version, which is more reliable than what most mods
 * declare about themselves.
 */
ipcMain.handle("github-list-releases", (_event, repoOrUrl: string) => listGithubReleases(repoOrUrl));

ipcMain.handle(
  "github-install-release",
  async (_event, args: { jobId: string; assetUrl: string; assetName: string; repo: string; version: string; releaseUrl?: string }) => {
    const roots = rootsFor("main");
    if (!roots) return { success: false, message: "No SPT instance configured." };
    return installForgeModVersion(
      roots.clientRoot,
      roots.serverRoot,
      args.assetUrl,
      // The repository name is a better guess at the mod's name than the asset filename,
      // which is usually the mod name plus a version that would end up in the folder name.
      args.repo.split("/")[1] ?? args.assetName,
      (receivedBytes, totalBytes) => {
        mainWindow?.webContents.send("download-progress", { jobId: args.jobId, receivedBytes, totalBytes });
      },
      {
        version: args.version,
        origin: "github",
        sourceUrl: args.releaseUrl ?? `https://github.com/${args.repo}`
      }
    );
  }
);

/* --- IPC: bulk reinstall ----------------------------------------------------
 * The most destructive thing the app can do, and the only way to give mods that were never
 * installed through it a real recorded version. See electron/bulkReinstall.ts for why each
 * safeguard is there.
 */
ipcMain.handle("preview-bulk-reinstall", () => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };
  const mods = reinstallableMods(scanInstance("main"));
  const configDirs = collectConfigPaths(roots.clientRoot, roots.serverRoot);
  const withoutRecord = mods.filter((m) => m.versionSource !== "recorded").length;
  // How many could be reinstalled from GitHub, which is what still works after 2026-08-10.
  const withRepo = mods.filter((m) => m.sourceRepo).length;
  return {
    success: true,
    modCount: mods.length,
    withoutRecord,
    withRepo,
    configDirs: configDirs.length,
    sptVersion: localSptVersion()
  };
});

ipcMain.handle("run-bulk-reinstall", async (_event, opts: { sptVersion?: string; source?: "forge" | "github" }) => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured.", outcomes: [], counts: null };

  const mods = reinstallableMods(scanInstance("main"));
  const outcomes: BulkReinstallOutcome[] = [];
  const report = (p: BulkReinstallProgress) => mainWindow?.webContents.send("bulk-reinstall-progress", p);

  // Config first, before a single byte is downloaded. If this fails, nothing else happens.
  let backup: { dir: string; files: number };
  report({ phase: "backup", done: 0, total: mods.length, message: "Backing up configuration…" });
  try {
    backup = backupConfigs(roots.clientRoot, roots.serverRoot);
  } catch (err: any) {
    return {
      success: false,
      message: `Stopped before changing anything: the configuration backup failed (${err?.message ?? err}).`,
      outcomes: [],
      counts: null
    };
  }

  const source = opts?.source ?? "forge";

  /**
   * Where each mod's download comes from.
   *
   * Forge resolves in one batched pass (by GUID, sharing the rate-limit budget). GitHub has
   * to be one request per repository, and unauthenticated GitHub allows only 60 an hour —
   * so a 59-mod install spends essentially the whole budget on a single run. That is a real
   * constraint, surfaced in the dialog rather than discovered as a wall of 403s.
   */
  type Resolved = { downloadLink: string; version?: string; name?: string; guid?: string; origin: "forge" | "github"; sourceUrl?: string };
  const resolved = new Map<string, Resolved>();

  report({ phase: "resolve", done: 0, total: mods.length, message: "Looking mods up…" });

  if (source === "github") {
    let done = 0;
    for (const mod of mods) {
      done++;
      report({ phase: "resolve", done, total: mods.length, current: mod.name });
      if (!mod.sourceRepo) continue;
      const release = await fetchLatestGithubRelease(mod.sourceRepo);
      if (release.error || !release.assetUrl) continue;
      resolved.set(mod.id, {
        downloadLink: release.assetUrl,
        version: release.version,
        name: mod.originalName,
        origin: "github",
        sourceUrl: release.url
      });
    }
  } else {
    const found = await findForgeDownloadsForNames(
      mods.map((m) => ({ name: m.originalName, guid: m.guid })),
      (done, total) => report({ phase: "resolve", done, total }),
      roots.clientRoot,
      // The whole premise of the dialog is "mods for THIS SPT version". Without this the
      // resolver returned each mod's newest release regardless, which installed builds for
      // a different SPT — DynamicMaps 1.2.0 onto a 4.0.13 install.
      opts?.sptVersion ?? localSptVersion()
    );
    for (const mod of mods) {
      const hit = found[mod.originalName];
      if (hit?.downloadLink) {
        resolved.set(mod.id, {
          downloadLink: hit.downloadLink,
          version: hit.version,
          name: hit.forgeName,
          guid: hit.guid,
          origin: "forge"
        });
      }
    }
  }

  let index = 0;
  for (const mod of mods) {
    index++;
    report({ phase: "install", done: index, total: mods.length, current: mod.name });
    const hit = resolved.get(mod.id);
    if (!hit) {
      // Not resolvable is NOT a reason to remove anything — the existing copy stays.
      outcomes.push({
        name: mod.name,
        status: "not-found",
        fromVersion: mod.version,
        detail:
          source === "github"
            ? mod.sourceRepo
              ? `No downloadable release on ${mod.sourceRepo}.`
              : "No known GitHub repository for this mod."
            : `Nothing published for SPT ${opts?.sptVersion ?? localSptVersion() ?? "?"}, or couldn't find it on Forge.`
      });
      continue;
    }
    try {
      const result = await installForgeModVersion(
        roots.clientRoot,
        roots.serverRoot,
        hit.downloadLink,
        hit.name ?? mod.originalName,
        (receivedBytes, totalBytes) =>
          report({ phase: "install", done: index, total: mods.length, current: mod.name, message: `${receivedBytes}/${totalBytes}` }),
        { name: hit.name, version: hit.version, guid: hit.guid, origin: hit.origin, sourceUrl: hit.sourceUrl }
      );
      // A mod that was DISABLED must come back disabled.
      //
      // Installing always writes to the enabled location, so reinstalling a disabled mod
      // produced a second, enabled copy sitting beside the old disabled one — which is how
      // LootingBots ended up installed twice. Putting the new copy back where the old one
      // was both restores the user's choice and consumes the stale copy, because moving it
      // there overwrites what is already sitting in that slot.
      let stateNote: string | undefined;
      if (result.success && !mod.enabled) {
        try {
          const stale = resolveModPath(roots.clientRoot, roots.serverRoot, { id: mod.id, type: mod.type, enabled: false });
          if (fs.existsSync(stale)) fs.rmSync(stale, { recursive: true, force: true });
          const toggled = toggleMod(roots.clientRoot, roots.serverRoot, { ...mod, enabled: true });
          stateNote = toggled.success ? undefined : "reinstalled, but could not be set back to disabled";
        } catch (err: any) {
          stateNote = `reinstalled, but could not be set back to disabled (${err?.message ?? err})`;
        }
      }

      outcomes.push({
        name: mod.name,
        status: result.success ? "reinstalled" : "failed",
        fromVersion: mod.version,
        toVersion: result.success ? hit.version : undefined,
        detail: result.success ? stateNote : result.message
      });
    } catch (err: any) {
      outcomes.push({ name: mod.name, status: "failed", fromVersion: mod.version, detail: err?.message ?? String(err) });
    }
  }

  report({ phase: "restore", done: mods.length, total: mods.length, message: "Restoring configuration…" });
  let restored = 0;
  try {
    restored = restoreConfigs(roots.clientRoot, roots.serverRoot, backup.dir);
  } catch {
    /* the backup is still on disk; say so below rather than throwing it away */
  }

  const counts = {
    reinstalled: outcomes.filter((o) => o.status === "reinstalled").length,
    notFound: outcomes.filter((o) => o.status === "not-found").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length
  };

  report({ phase: "done", done: mods.length, total: mods.length });

  return {
    success: counts.failed === 0,
    backupDir: backup.dir,
    outcomes,
    counts,
    message:
      `Reinstalled ${counts.reinstalled} of ${mods.length} mod(s) from ${source === "github" ? "GitHub" : "Forge"}; ` +
      `restored ${restored} config file(s).` +
      (counts.notFound ? ` ${counts.notFound} could not be found and were left alone.` : "") +
      (counts.failed ? ` ${counts.failed} failed.` : "") +
      ` Configuration backup kept at ${backup.dir}`
  };
});

/* --- IPC: mod presets (phase 1: local) --------------------------------------
 * Presets live in the app's data directory rather than inside an instance: the whole point
 * of a preset is that it can be applied to a DIFFERENT install from the one it came from.
 */
function presetRoot(): string {
  return app.getPath("userData");
}

/**
 * Addons installed here, in the shape a preset stores them.
 *
 * Read from the ledger rather than from the mod list, because most addons unpack into their
 * parent's folder and have no mod row at all. A preset built from the mod list alone
 * described zero addons on an install that had three.
 */
function localPresetAddons(): PresetAddon[] {
  const roots = rootsFor("main");
  if (!roots) return [];
  return loadAddonLedger(roots.clientRoot).map((r) => ({
    name: r.name,
    forgeAddonId: r.forgeAddonId,
    version: r.version,
    parentName: r.parentName,
    parentType: r.parentType,
    parentConstraint: r.parentConstraint,
    source: r.source,
    mergedIntoParent: r.mergedIntoParent,
    folders: r.folders?.length ? r.folders : undefined
  }));
}

function localSptVersion(): string | undefined {
  const sptPath = store.get("sptPath");
  return (store.get("sptVersionOverride") ?? (sptPath ? detectSptSemver(sptPath) : undefined)) ?? undefined;
}

ipcMain.handle("list-presets", () => listPresets(presetRoot()));

ipcMain.handle("create-preset", (_event, opts: { name: string; description?: string; optional?: string[] }) => {
  if (!store.get("sptPath")) return { success: false, message: "No SPT instance configured." };
  if (!opts?.name?.trim()) return { success: false, message: "A preset needs a name." };
  try {
    const preset = createPreset(presetRoot(), scanInstance("main"), {
      name: opts.name,
      description: opts.description,
      optional: opts.optional,
      sptVersion: localSptVersion(),
      addons: localPresetAddons()
    });
    return {
      success: true,
      preset,
      message:
        `Saved "${preset.name}" with ${preset.mods.length} mod(s)` +
        (preset.addons?.length ? ` and ${preset.addons.length} addon(s).` : ".")
    };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't save that preset." };
  }
});

ipcMain.handle("update-preset", (_event, id: string) => {
  if (!store.get("sptPath")) return { success: false, message: "No SPT instance configured." };
  const preset = updatePreset(presetRoot(), id, scanInstance("main"), localSptVersion(), localPresetAddons());
  return preset
    ? { success: true, preset, message: `Updated "${preset.name}" from the current install.` }
    : { success: false, message: "That preset no longer exists." };
});

ipcMain.handle("rename-preset", (_event, id: string, name: string, description?: string) => {
  const preset = renamePreset(presetRoot(), id, name, description);
  return preset ? { success: true, preset } : { success: false, message: "That preset no longer exists." };
});

ipcMain.handle("delete-preset", (_event, id: string) => deletePreset(presetRoot(), id));

ipcMain.handle("get-preset-report", (_event, id: string) => {
  const preset = readPreset(presetRoot(), id);
  if (!preset) return { success: false, message: "That preset no longer exists." };
  if (!store.get("sptPath")) return { success: false, message: "No SPT instance configured." };
  return { success: true, report: buildPresetReport(preset, scanInstance("main"), localSptVersion(), localPresetAddons()) };
});

/**
 * Applies what can be applied without downloading anything: enabling and disabling mods so
 * the install matches the preset.
 *
 * Deliberately does NOT remove "extra" mods. A preset says what a setup needs, not what it
 * forbids, and deleting somebody's mods because they are absent from a list is a far more
 * destructive reading than the user asked for. Missing mods need a payload or Forge, which
 * is phase 3 — until then they are reported.
 */
ipcMain.handle("apply-preset-state", (_event, id: string) => {
  const preset = readPreset(presetRoot(), id);
  if (!preset) return { success: false, message: "That preset no longer exists." };
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };

  const report = buildPresetReport(preset, scanInstance("main"), localSptVersion(), localPresetAddons());
  const toToggle = report.rows.filter((r) => r.issue === "state-mismatch");
  if (toToggle.length === 0) {
    return { success: true, changed: 0, message: "Nothing to change — enabled states already match." };
  }

  const current = scanInstance("main");
  const changed: string[] = [];
  const failed: string[] = [];
  for (const row of toToggle) {
    const mod = current.find((m) => m.id.toLowerCase() === row.name.toLowerCase() && m.type === row.type);
    if (!mod) {
      failed.push(row.name);
      continue;
    }
    const result = toggleMod(roots.clientRoot, roots.serverRoot, mod);
    (result.success ? changed : failed).push(row.name);
  }

  return {
    success: failed.length === 0,
    changed: changed.length,
    message:
      `Switched ${changed.length} mod(s) to match the preset.` +
      (failed.length ? ` ${failed.length} could not be changed.` : "")
  };
});

/* --- IPC: the shared preset store (phase 2: manifests only) -----------------
 *
 * The store is a folder someone else can also reach — a Windows share, a VPN path, a synced
 * directory. Access control belongs to the share; the write policy in store.json is a
 * convention between clients, and the UI says so rather than implying otherwise.
 *
 * Note the store is NOT an instance. It holds manifests, never an install, so none of the
 * scan/toggle/install paths can be pointed at it.
 */
function presetIdentity(): string {
  // Defaulting to the OS username makes publishing work without a setup step, but it is only
  // a default: this name goes in front of other people, so the user can change it.
  return (store.get("presetIdentity") ?? os.userInfo().username ?? "").trim();
}

ipcMain.handle("get-preset-store-status", async () =>
  getStoreStatus(store.get("presetStorePath"), presetIdentity())
);

ipcMain.handle("get-preset-identity", () => ({
  identity: presetIdentity(),
  explicit: !!store.get("presetIdentity")
}));

ipcMain.handle("set-preset-identity", (_event, name: string) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { success: false, message: "Pick a name others will recognise." };
  store.set("presetIdentity", trimmed);
  return { success: true, identity: trimmed, message: `Publishing as ${trimmed}.` };
});

ipcMain.handle("choose-preset-store", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a preset store folder",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true };
  const dir = result.filePaths[0];
  const status = await getStoreStatus(dir, presetIdentity());
  // Connecting to a folder that is not a store yet is not a failure — the panel offers to
  // create one there. The path is remembered either way so the offer has something to act on.
  store.set("presetStorePath", dir);
  return { success: true, status };
});

ipcMain.handle("disconnect-preset-store", () => {
  store.set("presetStorePath", null);
  return { success: true, message: "Disconnected from the store. Nothing was deleted." };
});

ipcMain.handle("create-preset-store", async (_event, name: string, writePolicy: WritePolicy) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "Choose a folder first." };
  const identity = presetIdentity();
  const result = await initStore(dir, { name, owner: identity, writePolicy });
  return { ...result, status: await getStoreStatus(dir, identity) };
});

ipcMain.handle("set-preset-store-policy", async (_event, policy: WritePolicy) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const identity = presetIdentity();
  const result = await setWritePolicy(dir, identity, policy);
  return { ...result, status: await getStoreStatus(dir, identity) };
});

ipcMain.handle("publish-preset", async (_event, id: string, overwrite?: boolean) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const preset = readPreset(presetRoot(), id);
  if (!preset) return { success: false, message: "That preset no longer exists." };
  const identity = presetIdentity();
  const result = await publishPreset(dir, preset, identity, { overwrite });
  return { ...result, status: await getStoreStatus(dir, identity) };
});

ipcMain.handle("unpublish-preset", async (_event, id: string) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const identity = presetIdentity();
  const result = await unpublishPreset(dir, id, identity);
  return { ...result, status: await getStoreStatus(dir, identity) };
});

ipcMain.handle("import-preset", async (_event, id: string, overwrite?: boolean) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  return importPreset(presetRoot(), dir, id, { overwrite });
});

/**
 * Compares a store preset against this install WITHOUT importing it.
 *
 * "Are we running the same thing?" is the question people actually ask before a session, and
 * making them import a copy of someone else's preset just to ask it would leave a trail of
 * stale presets behind.
 */
ipcMain.handle("get-store-preset-report", async (_event, id: string) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  if (!store.get("sptPath")) return { success: false, message: "No SPT instance configured." };
  const preset = await readStorePreset(dir, id);
  if (!preset) return { success: false, message: "That preset is not in this store." };
  return { success: true, report: buildPresetReport(preset, scanInstance("main"), localSptVersion(), localPresetAddons()) };
});

/* --- IPC: addons (v1.2.2) ----------------------------------------------------
 * An addon is a mod whose reason to exist is another mod — a compatibility patch, a preset
 * pack, a Fika sync shim. Two halves, because they answer different questions and only one
 * of them survives the shutdown:
 *
 *   the catalogue  — what exists and what it attaches to (harvested, frozen on 2026-08-10)
 *   the install    — what is already here and what it is wired to (read from the files,
 *                    works forever)
 */
function addonCataloguePaths(): string[] {
  return [
    path.join(process.resourcesPath ?? "", "data", "forge-addons.json"),
    path.join(app.getAppPath(), "data", "forge-addons.json"),
    path.join(__dirname, "..", "data", "forge-addons.json")
  ];
}

function forgeIdsByFolder(clientRoot: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(clientRoot, ".spt-mod-manager-forge-match.json"), "utf-8"));
    const out: Record<string, string> = {};
    for (const [folder, entry] of Object.entries<any>(raw?.entries ?? {})) {
      if (entry?.modId) out[folder] = String(entry.modId);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Addon ids already installed here, so the catalogue can say "you have this".
 *
 * Read from the ADDON LEDGER, not the mod registry. Most addons unpack into their parent's
 * folder and never get a registry entry of their own — the Icebreaker Fika sync lands in
 * `ManimalIcebreaker`, the CAG BRNVG patch in `BorkelRNVG` — so a registry-based answer said
 * "not installed" for addons that plainly were.
 */
function installedAddonIds(clientRoot: string): Set<number> {
  const ids = new Set<number>();
  for (const record of loadAddonLedger(clientRoot)) {
    if (typeof record.forgeAddonId === "number") ids.add(record.forgeAddonId);
  }
  // Registry marks still count, for addons that DID get their own folder.
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(clientRoot, ".spt-mod-manager-registry.json"), "utf-8"));
    for (const e of reg) if (typeof e.forgeAddonId === "number") ids.add(e.forgeAddonId);
  } catch {
    /* no registry */
  }
  return ids;
}

ipcMain.handle("get-addon-suggestions", () => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };
  const catalogue = loadAddonCatalogue(addonCataloguePaths());
  if (catalogue.length === 0) {
    return { success: false, message: "The addon catalogue is missing from this build." };
  }
  const suggestions = suggestAddons(
    scanInstance("main"),
    forgeIdsByFolder(roots.clientRoot),
    catalogue,
    installedAddonIds(roots.clientRoot)
  );
  return {
    success: true,
    suggestions,
    catalogueSize: catalogue.length,
    // Everything this app has installed as an addon, including the many that have no folder
    // of their own and are therefore invisible in the mod list. Each is flagged when a later
    // reinstall of its parent has silently wiped its files.
    ledger: withReinstallFlags(roots.clientRoot)
  };
});

/**
 * The addon ledger, with `needsReinstall` filled in.
 *
 * Reinstalling a mod replaces its folder, which takes any addon that unpacked into it along
 * too — and nothing about the parent's own row changes, so it happens in silence. Measured:
 * reinstalling Borkel's RNVG left zero files of the CAG BRNVG patch behind.
 */
function withReinstallFlags(clientRoot: string) {
  const ledger = loadAddonLedger(clientRoot);
  let registry: any[] = [];
  try {
    registry = JSON.parse(fs.readFileSync(path.join(clientRoot, ".spt-mod-manager-registry.json"), "utf-8"));
  } catch {
    /* no registry */
  }
  const installedAt = (name: string, type: ModType) =>
    registry.find((e) => e.id?.toLowerCase() === name.toLowerCase() && e.type === type)?.installedAt;

  const stale = new Set(addonsNeedingReinstall(ledger, installedAt).map((r) => `${r.forgeAddonId ?? r.name}`));
  return ledger.map((r) => ({ ...r, needsReinstall: stale.has(`${r.forgeAddonId ?? r.name}`) }));
}

/**
 * Drops an addon from the ledger without touching files.
 *
 * Honest about its limits: an addon that unpacked into its parent's folder cannot be removed
 * separately, because its files are mixed in with the parent's. The only clean way back is to
 * reinstall the parent. Pretending otherwise would mean deleting files that might belong to
 * either one.
 */
ipcMain.handle("forget-addon", (_event, forgeAddonId?: number, name?: string) => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };
  const removed = forgetAddon(roots.clientRoot, { forgeAddonId, name });
  return {
    success: removed,
    message: removed
      ? "Removed from the addon list. Its files were left alone — reinstall the parent mod to clear them."
      : "That addon was not in the list."
  };
});

/**
 * Reads the installed mods' own assemblies to work out what is attached to what.
 *
 * On demand rather than part of every scan: reading assemblies is far more expensive than
 * listing folders, and the scan runs constantly. This is also the half that keeps working
 * after Forge is gone.
 */
ipcMain.handle("detect-addon-links", () => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };
  const mods = scanInstance("main");
  const manual = store.get("addonLinks") ?? {};
  const links = detectAddonLinks(roots.clientRoot, mods, manual);

  // Reuses the indexed harvest the source resolver already keeps in memory — it is 1.4 MB of
  // JSON, and a second reader would parse it all over again.
  const { byGuid } = loadHarvest();
  const integrations = findKnownIntegrations(roots.clientRoot, mods, (g) => {
    const hit = byGuid.get(g.trim().toLowerCase());
    // A harvested mod without a name is not worth reporting: "something you don't have"
    // tells the user nothing they can act on.
    return hit?.name ? { id: hit.id, name: hit.name } : undefined;
  });

  return { success: true, links, integrations };
});

/** The user's judgement outranks anything derived, as everywhere else in the app. */
ipcMain.handle("set-addon-parent", (_event, id: string, type: ModType, parentName: string | null) => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };
  const registryPath = path.join(roots.clientRoot, ".spt-mod-manager-registry.json");
  const links = { ...(store.get("addonLinks") ?? {}) };
  const key = `${type}:${id.toLowerCase()}`;

  if (!parentName) {
    delete links[key];
    store.set("addonLinks", links);
    clearAddonMark(registryPath, id, type);
    return { success: true, message: `"${id}" is no longer marked as an addon.` };
  }

  const parent = scanInstance("main").find((m) => m.id.toLowerCase() === parentName.toLowerCase());
  if (!parent) return { success: false, message: `"${parentName}" is not installed.` };
  links[key] = parent.id;
  store.set("addonLinks", links);
  markInstalledAsAddon(registryPath, [{ id, type }], { parentName: parent.id, parentType: parent.type });
  return { success: true, message: `"${id}" is now an addon of "${parent.id}".` };
});

/**
 * Installs a catalogued addon from Forge, pinned to the build that fits the parent installed.
 *
 * Deliberately does NOT take a version from the renderer: which build fits is a function of
 * the parent's installed version, and that is known here.
 */
ipcMain.handle("install-forge-addon", async (_event, jobId: string, addonId: number) => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };

  const catalogue = loadAddonCatalogue(addonCataloguePaths());
  const addon = catalogue.find((a) => a.id === addonId);
  if (!addon) return { success: false, message: "That addon is not in the catalogue." };

  const mods = scanInstance("main");
  const forgeIds = forgeIdsByFolder(roots.clientRoot);
  const parent = mods.find((m) => String(forgeIds[m.id] ?? forgeIds[m.originalName] ?? "") === String(addon.modId));
  if (!parent) {
    return { success: false, message: `"${addon.name}" attaches to a mod you don't have installed.` };
  }

  const picked = pickAddonVersionForParent(addon, parent.version);
  if (!picked?.version.link) {
    return {
      success: false,
      // Naming the parent's version is the actionable part: the fix is to update the parent,
      // not to go looking for the addon somewhere else.
      message: `No build of "${addon.name}" fits ${parent.id} ${parent.version ?? "(unknown version)"}.`
    };
  }

  const registryPath = path.join(roots.clientRoot, ".spt-mod-manager-registry.json");
  const before = new Set(scanInstance("main").map((m) => `${m.type}:${m.id}`));
  // Taken so the addon cannot relabel the mod it patches. Installing the CAG BRNVG patch
  // (v1.0.0) into Borkel's RNVG rewrote that mod's recorded version from 2.1.1 to 1.0.0.
  const versionsBefore = snapshotVersions(registryPath);

  const result = await installForgeModVersion(
    roots.clientRoot,
    roots.serverRoot,
    picked.version.link,
    addon.name,
    (receivedBytes, totalBytes) => mainWindow?.webContents.send("download-progress", { jobId, receivedBytes, totalBytes }),
    { name: addon.name, version: picked.version.version }
  );
  if (!result.success) return result;

  const restored = restoreClobberedVersions(registryPath, versionsBefore);

  const added = scanInstance("main")
    .filter((m) => !before.has(`${m.type}:${m.id}`))
    .map((m) => ({ id: m.id, type: m.type }));

  // Marks whatever the archive produced — an addon can drop a server and a client part
  // exactly like a mod. Frequently it produces nothing new at all, which is why the ledger
  // below is the record that actually matters.
  markInstalledAsAddon(registryPath, added, {
    parentName: parent.id,
    parentType: parent.type,
    forgeAddonId: addon.id,
    parentConstraint: picked.version.modConstraint
  });

  recordAddonInstall(roots.clientRoot, {
    forgeAddonId: addon.id,
    name: addon.name,
    version: picked.version.version,
    parentName: parent.id,
    parentType: parent.type,
    parentConstraint: picked.version.modConstraint,
    installedAt: new Date().toISOString(),
    source: "forge",
    folders: added,
    mergedIntoParent: added.length === 0
  });

  return {
    ...result,
    message:
      `${result.message} Recorded as an addon of "${parent.id}".` +
      // Said out loud: an addon with no folder of its own cannot be uninstalled separately,
      // and finding that out later would be worse than being told now.
      (added.length === 0 ? ` It installed into ${parent.id}'s own folder rather than its own.` : "") +
      (restored.length ? ` Kept ${restored.join(", ")} at its own version.` : ""),
    installedAs: added.map((a) => a.id),
    mergedIntoParent: added.length === 0
  };
});

/**
 * Installs an addon from a local archive and attaches it to a parent.
 *
 * The path that still works when Forge is gone and the addon was never on Forge to begin
 * with — a patch a friend sent, or one built by hand.
 */
ipcMain.handle("install-addon-from-file", async (_event, parentName: string, filePath?: string) => {
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };

  const parent = scanInstance("main").find((m) => m.id.toLowerCase() === parentName?.toLowerCase());
  if (!parent) return { success: false, message: `"${parentName}" is not installed.` };

  let archive = filePath;
  if (!archive) {
    const chosen = await dialog.showOpenDialog({
      title: `Install an addon for ${parent.id}`,
      properties: ["openFile"],
      filters: [{ name: "Mod archive", extensions: ["zip", "7z", "rar"] }]
    });
    if (chosen.canceled || !chosen.filePaths[0]) return { success: false, cancelled: true };
    archive = chosen.filePaths[0];
  }

  const registryPath = path.join(roots.clientRoot, ".spt-mod-manager-registry.json");
  const before = new Set(scanInstance("main").map((m) => `${m.type}:${m.id}`));
  const versionsBefore = snapshotVersions(registryPath);

  const result = await installModFromArchive(roots.clientRoot, roots.serverRoot, archive);
  if (!result.success) return result;

  const restored = restoreClobberedVersions(registryPath, versionsBefore);
  const added = scanInstance("main")
    .filter((m) => !before.has(`${m.type}:${m.id}`))
    .map((m) => ({ id: m.id, type: m.type }));
  markInstalledAsAddon(registryPath, added, { parentName: parent.id, parentType: parent.type });

  recordAddonInstall(roots.clientRoot, {
    name: path.basename(archive).replace(/\.(zip|7z|rar)$/i, ""),
    parentName: parent.id,
    parentType: parent.type,
    installedAt: new Date().toISOString(),
    source: "file",
    folders: added,
    mergedIntoParent: added.length === 0
  });

  return {
    ...result,
    message:
      `${result.message} Recorded as an addon of "${parent.id}".` +
      (added.length === 0 ? ` It installed into ${parent.id}'s own folder rather than its own.` : "") +
      (restored.length ? ` Kept ${restored.join(", ")} at its own version.` : ""),
    installedAs: added.map((a) => a.id),
    mergedIntoParent: added.length === 0
  };
});

/**
 * Installs an addon from a GitHub release, attached to a parent.
 *
 * Reuses the existing GitHub release picker wholesale — after Forge shuts down, GitHub is
 * where addons will keep being published, and that path is already built and tested.
 */
ipcMain.handle(
  "install-addon-from-github",
  async (
    _event,
    args: { jobId: string; parentName: string; assetUrl: string; assetName: string; repo: string; version: string }
  ) => {
    const roots = rootsFor("main");
    if (!roots) return { success: false, message: "No SPT instance configured." };
    const parent = scanInstance("main").find((m) => m.id.toLowerCase() === args.parentName?.toLowerCase());
    if (!parent) return { success: false, message: `"${args.parentName}" is not installed.` };

    const registryPath = path.join(roots.clientRoot, ".spt-mod-manager-registry.json");
    const before = new Set(scanInstance("main").map((m) => `${m.type}:${m.id}`));
    const versionsBefore = snapshotVersions(registryPath);

    const result = await installForgeModVersion(
      roots.clientRoot,
      roots.serverRoot,
      args.assetUrl,
      args.repo.split("/")[1] ?? args.assetName,
      (receivedBytes, totalBytes) =>
        mainWindow?.webContents.send("download-progress", { jobId: args.jobId, receivedBytes, totalBytes }),
      { version: args.version, origin: "github", sourceUrl: `https://github.com/${args.repo}` }
    );
    if (!result.success) return result;

    const restored = restoreClobberedVersions(registryPath, versionsBefore);
    const added = scanInstance("main")
      .filter((m) => !before.has(`${m.type}:${m.id}`))
      .map((m) => ({ id: m.id, type: m.type }));
    markInstalledAsAddon(registryPath, added, { parentName: parent.id, parentType: parent.type });

    recordAddonInstall(roots.clientRoot, {
      name: args.repo.split("/")[1] ?? args.assetName,
      version: args.version,
      parentName: parent.id,
      parentType: parent.type,
      installedAt: new Date().toISOString(),
      source: "github",
      folders: added,
      mergedIntoParent: added.length === 0
    });

    return {
      ...result,
      message:
        `${result.message} Recorded as an addon of "${parent.id}".` +
        (added.length === 0 ? ` It installed into ${parent.id}'s own folder rather than its own.` : "") +
        (restored.length ? ` Kept ${restored.join(", ")} at its own version.` : ""),
      installedAs: added.map((a) => a.id),
      mergedIntoParent: added.length === 0
    };
  }
);

/* --- IPC: preset payloads (phase 3) ------------------------------------------
 * The part that removes Forge from the equation: a preset that carries the mod files needs
 * no catalogue and no downloads.
 *
 * These are the only preset operations that can run for tens of minutes — the reference
 * install is 17.8 GB — so they stream progress and can be cancelled. Cancelling is safe:
 * copies are staged and only renamed into place when complete, and staging is resumable.
 */
let payloadCancelled = false;

ipcMain.handle("cancel-preset-payloads", () => {
  payloadCancelled = true;
  return { success: true, message: "Stopping after the current file. Progress is kept." };
});

ipcMain.handle("get-store-usage", async () => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const usage = await storeUsage(dir);
  return { success: true, usage, human: formatBytes(usage.bytes) };
});

ipcMain.handle("publish-preset-with-payloads", async (_event, id: string, overwrite?: boolean) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };
  const preset = readPreset(presetRoot(), id);
  if (!preset) return { success: false, message: "That preset no longer exists." };

  payloadCancelled = false;
  const identity = presetIdentity();
  const result = await publishPresetWithPayloads(
    dir,
    preset,
    identity,
    roots,
    scanInstance("main"),
    (p) => mainWindow?.webContents.send("preset-payload-progress", { ...p, phase: "publish" }),
    { overwrite, isCancelled: () => payloadCancelled }
  );
  return { ...result, status: await getStoreStatus(dir, identity) };
});

/**
 * Installs the mods a store preset carries but this install lacks.
 *
 * Additive only, deliberately. A mod present here and absent from the preset is left alone:
 * a preset says what a setup needs, not what it forbids.
 */
ipcMain.handle("install-preset-payloads", async (_event, id: string, names?: string[]) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const roots = rootsFor("main");
  if (!roots) return { success: false, message: "No SPT instance configured." };
  const preset = (await readStorePreset(dir, id)) ?? readPreset(presetRoot(), id);
  if (!preset) return { success: false, message: "That preset could not be found." };

  payloadCancelled = false;
  const result = await applyPresetPayloads(
    dir,
    preset,
    roots,
    names ?? null,
    (p) => mainWindow?.webContents.send("preset-payload-progress", { ...p, phase: "install" }),
    () => payloadCancelled
  );
  return result;
});

ipcMain.handle("verify-preset-payloads", async (_event, id: string, deep?: boolean) => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const preset = (await readStorePreset(dir, id)) ?? readPreset(presetRoot(), id);
  if (!preset) return { success: false, message: "That preset could not be found." };

  const results = [];
  for (const mod of preset.mods) {
    if (!mod.payload) continue;
    results.push({ name: mod.name, ...(await verifyPayload(dir, mod.payload, deep)) });
  }
  const bad = results.filter((r) => !r.ok);
  return {
    success: bad.length === 0,
    results,
    message: bad.length === 0
      ? `All ${results.length} payload(s) check out${deep ? " (contents re-hashed)" : ""}.`
      : `${bad.length} of ${results.length} payload(s) are not intact.`
  };
});

/** Frees space by deleting payloads no preset in the store refers to any more. */
ipcMain.handle("clean-store-payloads", async () => {
  const dir = store.get("presetStorePath");
  if (!dir) return { success: false, message: "No store connected." };
  const inUse = await payloadKeysInUse(dir);
  const result = await collectOrphanPayloads(dir, inUse);
  return {
    success: true,
    ...result,
    message:
      result.removed.length || result.staleStaging
        ? `Removed ${result.removed.length} unused payload(s), freeing ${formatBytes(result.bytesFreed)}.` +
          (result.staleStaging ? ` Cleared ${result.staleStaging} finished staging folder(s).` : "")
        : "Nothing to clean up — every payload is still in use."
  };
});

/* --- IPC: preset files -------------------------------------------------------
 * Sharing with no store at all. A manifest is ~40 KB, so sending someone the file is the
 * lowest-effort transport there is, and it needs nothing set up on either end. Same format
 * the store holds, so a file can be dropped into a store's presets/ folder and vice versa.
 */
ipcMain.handle("export-preset-file", async (_event, id: string) => {
  const preset = readPreset(presetRoot(), id);
  if (!preset) return { success: false, message: "That preset no longer exists." };

  const result = await dialog.showSaveDialog({
    title: "Export preset",
    defaultPath: presetFileName(preset),
    filters: [{ name: "Mod preset", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };
  return exportPresetToFile(preset, result.filePath);
});

ipcMain.handle("import-preset-file", async (_event, overwrite?: boolean, knownPath?: string) => {
  // The second call (after the user confirms an overwrite) reuses the path already chosen,
  // rather than making them find the same file in the dialog a second time.
  let filePath = knownPath;
  if (!filePath) {
    const result = await dialog.showOpenDialog({
      title: "Import a preset file",
      properties: ["openFile"],
      filters: [{ name: "Mod preset", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true };
    filePath = result.filePaths[0];
  }
  const imported = await importPresetFromFile(presetRoot(), filePath, { overwrite });
  return { ...imported, path: filePath };
});

/* --- IPC: syncing the headless client from the main install -----------------
 * One direction only: main -> headless. The main install is the copy the user configures
 * and plays with, so it is the source of truth, and Fika's own guidance is to configure on
 * the main game and copy across rather than install twice.
 */
ipcMain.handle("sync-mod-to-headless", (_event, mod: ModInfo) => {
  const sptPath = store.get("sptPath");
  const headlessPath = store.get("headlessPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  if (!headlessPath) return { success: false, message: "No headless client configured." };
  return copyClientModToHeadless(sptPath, headlessPath, mod);
});

ipcMain.handle("remove-mod-from-headless", (_event, mod: ModInfo) => {
  const headlessPath = store.get("headlessPath");
  if (!headlessPath) return { success: false, message: "No headless client configured." };
  return removeModFromHeadless(headlessPath, mod);
});

/**
 * Copies every plugin the parity report says is missing from the headless client or drifted
 * out of version with it.
 *
 * Scoped to what MUST match — required and recommended — rather than everything present.
 * Copying the cosmetic mods too would be easy and wrong: they gain the headless client
 * nothing, and menu-patching ones can stop it hosting at all.
 */
ipcMain.handle("sync-all-to-headless", (_event) => {
  const sptPath = store.get("sptPath");
  const headlessPath = store.get("headlessPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  if (!headlessPath) return { success: false, message: "No headless client configured." };

  const mainMods = scanInstance("main");
  const headlessMods = scanInstance("headless");
  const report = buildParityReport(mainMods, headlessMods, {
    manual: headlessOverrides(),
    forge: { ...forgeHintsFor(mainMods), ...forgeHintsFor(headlessMods) }
  });

  const wanted = report.rows.filter(
    (row) =>
      (row.issue === "missing-required" || row.issue === "missing-recommended" || row.issue === "version-drift") &&
      row.type !== "server"
  );

  // Keyed by parityKey, NOT by name. Several mods ship a server half and a client half under
  // one folder name; keyed by name alone the map ends up holding whichever was scanned last,
  // which is the SERVER half — and the copy is then correctly refused as a server mod, so the
  // client plugin silently never syncs. Cost two plugins on the reference install
  // (acidphantasm-botplacementsystem, WTT-PackNStrap) and reported success while doing it.
  const byKey = new Map(mainMods.map((m) => [parityKey(m), m]));
  const done: string[] = [];
  const failed: string[] = [];

  for (const row of wanted) {
    const mod = byKey.get(row.key);
    if (!mod) {
      failed.push(row.name);
      continue;
    }
    const result = copyClientModToHeadless(sptPath, headlessPath, mod);
    (result.success ? done : failed).push(mod.name);
  }

  if (!wanted.length) return { success: true, message: "Nothing to sync — the headless client already matches.", copied: 0 };
  return {
    success: failed.length === 0,
    copied: done.length,
    message:
      `Copied ${done.length} plugin(s) to the headless client.` +
      (failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}` : "")
  };
});

/* --- IPC: live SPT server (remote, READ-ONLY) ------------------------------
 * There are no write handlers here, by design. The user chose "read-only for remote": the
 * app reports what differs from the server and never touches it. Writing into a running
 * server's user/mods can break a raid in progress, and it is usually someone else's machine.
 */
ipcMain.handle("get-server-url", () => store.get("serverUrl"));

ipcMain.handle("set-server-url", async (_event, url: string) => {
  const parsed = normaliseServerUrl(url);
  if (!parsed) return { success: false, message: "That doesn't look like an address. Try 192.168.1.78:6969." };

  // Verified before saving, so a typo is caught here rather than showing up later as an
  // empty pane the user has to diagnose.
  const snapshot = await fetchServerSnapshot(parsed.origin);
  if (!snapshot.reachable) return { success: false, message: snapshot.error ?? "Could not reach that server." };

  store.set("serverUrl", parsed.origin);
  return {
    success: true,
    url: parsed.origin,
    message: `Connected to ${parsed.origin} — SPT ${snapshot.sptVersion ?? "?"}, ${snapshot.mods.length} server mod(s).`
  };
});

ipcMain.handle("clear-server-url", () => {
  store.set("serverUrl", null);
  return { success: true };
});

ipcMain.handle("get-server-sync", async () => {
  const serverUrl = store.get("serverUrl");
  if (!serverUrl) return { configured: false };

  const sptPath = store.get("sptPath");
  const localMods = sptPath ? scanInstance("main") : [];
  const localSpt = store.get("sptVersionOverride") ?? (sptPath ? detectSptSemver(sptPath) : undefined);

  const snapshot = await fetchServerSnapshot(serverUrl);
  return { configured: true, report: buildServerSyncReport(snapshot, localMods, localSpt ?? undefined) };
});

// The user's judgement outranks every rule — the same escape hatch the Forge matcher has.
ipcMain.handle("set-headless-override", (_event, modKey: string, klass: HeadlessClass | null) => {
  const key = normaliseModKey(modKey || "");
  if (!key) return { success: false, message: "A mod is required." };
  const overrides = { ...headlessOverrides() };
  if (klass) overrides[key] = klass;
  else delete overrides[key];
  store.set("headlessOverrides", overrides);
  return { success: true };
});

ipcMain.handle("get-spt-version", () => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return undefined;
  return detectSptVersion(sptPath);
});

ipcMain.handle("detect-conflicts", () => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { clientFileConflicts: [], duplicateServerNames: [] };
  return detectConflicts(sptPath, getServerRoot()!);
});

ipcMain.handle("get-spt-semver", () => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return undefined;
  return detectSptSemver(sptPath);
});

ipcMain.handle("get-spt-version-override", () => store.get("sptVersionOverride"));

ipcMain.handle("set-spt-version-override", (_event, value: string) => {
  store.set("sptVersionOverride", value || null);
});

ipcMain.handle("get-forge-spt-versions", () => getForgeSptVersions());

ipcMain.handle("get-forge-cache", () => ({
  statusCache: store.get("forgeStatusCache"),
  checkedAt: store.get("forgeCheckedAt")
}));

ipcMain.handle(
  "set-forge-cache",
  (_event, statusCache: { name: string; status: string; version?: string }[]) => {
    store.set("forgeStatusCache", statusCache as any);
    store.set("forgeCheckedAt", new Date().toISOString());
  }
);

ipcMain.handle("check-forge-updates", async (_event, mods: { name: string; originalName: string; version?: string; guid?: string; packageId?: string; packageInferred?: boolean }[], sptVersion: string) => {
  try {
    const result = await checkForgeUpdates(
      mods,
      sptVersion,
      (done, total) => {
        mainWindow?.webContents.send("forge-check-progress", { done, total });
      },
      store.get("sptPath") ?? undefined
    );
    return { success: true, result };
  } catch (err: any) {
    return { success: false, message: err?.message || "Failed to check for updates." };
  }
});

ipcMain.handle(
  "search-forge-mods",
  async (
    _event,
    params: { query?: string; categorySlug?: string; sptVersionConstraint?: string; sort?: string; page?: number }
  ) => {
    try {
      const result = await searchForgeMods(params);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, message: err?.message || "Failed to search mods on Forge." };
    }
  }
);

ipcMain.handle("get-forge-categories", () => getForgeCategories());

// --- IPC: manual Forge match override ---
// The escape hatch for everything automation cannot settle: a mod not published on Forge,
// one whose identity is genuinely ambiguous, or a guess the user knows to be wrong. A pin
// outranks every automatic strategy and is never overwritten by them.
ipcMain.handle("set-forge-match", (_event, originalName: string, modId: number) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  if (!originalName || !Number.isFinite(modId) || modId <= 0) {
    return { success: false, message: "A valid Forge mod ID is required." };
  }
  try {
    setManualForgeMatch(sptPath, originalName, modId);
    return { success: true, message: `Linked "${originalName}" to Forge mod ${modId}.` };
  } catch (err: any) {
    return { success: false, message: err?.message || "Couldn't save the link." };
  }
});

// "I already have this" — see the note on dismissed updates in modManager.ts.
ipcMain.handle("dismiss-forge-update", (_event, originalName: string, version: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  if (!originalName || !version) return { success: false, message: "A mod and version are required." };
  try {
    dismissForgeUpdate(sptPath, originalName, version);
    return { success: true, message: `Won't offer ${version} for "${originalName}" again.` };
  } catch (err: any) {
    return { success: false, message: err?.message || "Couldn't save that." };
  }
});

ipcMain.handle("undismiss-forge-update", (_event, originalName: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  try {
    undismissForgeUpdate(sptPath, originalName);
    return { success: true, message: `Updates for "${originalName}" will be offered again.` };
  } catch (err: any) {
    return { success: false, message: err?.message || "Couldn't remove that." };
  }
});

ipcMain.handle("clear-forge-match", (_event, originalName: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  try {
    clearManualForgeMatch(sptPath, originalName);
    return { success: true, message: `Removed the manual link for "${originalName}".` };
  } catch (err: any) {
    return { success: false, message: err?.message || "Couldn't remove the link." };
  }
});

ipcMain.handle("check-app-update", () => checkAppUpdate(app.getVersion()));

/* --- IPC: updating the app itself ------------------------------------------ */
ipcMain.handle("list-app-releases", () => listAppReleases(app.getVersion()));

ipcMain.handle("install-app-release", async (_event, tag: string) => {
  // Only meaningful for a packaged build: in development the "install" is a source tree run
  // by the electron binary, and replacing it would destroy the working copy.
  if (!app.isPackaged) {
    return { success: false, message: "Self-update only works in a packaged build, not when running from source." };
  }

  const { releases, error } = await listAppReleases(app.getVersion());
  if (error) return { success: false, message: error };
  const release = releases.find((r) => r.tag === tag);
  if (!release) return { success: false, message: `Release ${tag} not found.` };

  const exePath = app.getPath("exe");
  const result = await prepareUpdate({
    release,
    installDir: path.dirname(exePath),
    exeName: path.basename(exePath),
    pid: process.pid,
    onProgress: (received, total) => {
      mainWindow?.webContents.send("app-update-progress", { received, total });
    }
  });

  if (result.success) {
    // The swap script is already waiting for this process to exit — it cannot move the
    // folder until then. Give the renderer a moment to show the message first.
    setTimeout(() => app.quit(), 1200);
  }
  return result;
});

ipcMain.handle("open-release-page", (_event, url: string) => {
  // Allowlist, because the URL arrives from the renderer process, which is not trusted
  // enough to tell the OS to open arbitrary things in a browser.
  //
  // Permits any Forge mod page (needed by the "needs confirmation" flow, which links to
  // the mod a guess resolved to so it can be eyeballed) plus this fork's own repository.
  // The upstream repo is deliberately no longer allowed — see the note on the self-update
  // check in modManager.ts.
  const allowed =
    /^https:\/\/forge\.sp-tarkov\.com\/mod\/\d+/.test(url) ||
    /^https:\/\/github\.com\/cspicer5\/SPTarky-Mod-Manager-Spicy(\/|$)/.test(url);
  if (allowed) {
    shell.openExternal(url);
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle("find-forge-downloads-for-names", async (_event, entries: { name: string; guid?: string }[]) => {
  try {
    return await findForgeDownloadsForNames(
      entries,
      (done, total) => {
        mainWindow?.webContents.send("forge-check-progress", { done, total });
      },
      store.get("sptPath") ?? undefined
    );
  } catch {
    return {};
  }
});

ipcMain.handle("find-forge-download-for-name", async (_event, name: string, sptVersion?: string) => {
  try {
    return await findForgeDownloadForName(name, sptVersion);
  } catch (err: any) {
    return { found: false };
  }
});

ipcMain.handle(
  "install-forge-mod",
  async (
    _event,
    jobId: string,
    downloadLink: string,
    suggestedName: string,
    forgeInfo?: { name?: string; author?: string; version?: string; guid?: string }
  ) => {
    const sptPath = store.get("sptPath");
    if (!sptPath) return { success: false, message: "No SPT instance configured." };
    return installForgeModVersion(
      sptPath,
      getServerRoot()!,
      downloadLink,
      suggestedName,
      (receivedBytes, totalBytes) => {
        mainWindow?.webContents.send("download-progress", { jobId, receivedBytes, totalBytes });
      },
      forgeInfo
    );
  }
);

ipcMain.handle("install-mod", async () => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };

  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Mod archive", extensions: ["zip", "7z", "rar"] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false, message: "Cancelled." };

  return installModFromArchive(sptPath, getServerRoot()!, result.filePaths[0]);
});

ipcMain.handle("install-mod-from-path", async (_event, filePath: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".zip" && ext !== ".7z" && ext !== ".rar") {
    return { success: false, message: `File "${path.basename(filePath)}" is not a .zip, .7z, or .rar.` };
  }

  return installModFromArchive(sptPath, getServerRoot()!, filePath);
});

ipcMain.handle("install-mod-confirm", (_event, tmpDir: string, archivePath: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  return finalizeUnrecognizedInstall(sptPath, getServerRoot()!, tmpDir, archivePath);
});

ipcMain.handle("install-mod-abort", (_event, tmpDir: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  return discardPendingInstall(sptPath, tmpDir);
});

ipcMain.handle("toggle-mod", (_event, mod: ModInfo, target: InstanceId = "main") => {
  const roots = rootsFor(target);
  if (!roots) return { success: false, message: `No ${target} instance configured.` };
  return toggleMod(roots.clientRoot, roots.serverRoot, mod);
});

ipcMain.handle("uninstall-mod", (_event, mod: ModInfo, target: InstanceId = "main") => {
  const roots = rootsFor(target);
  if (!roots) return { success: false, message: `No ${target} instance configured.` };
  return uninstallMod(roots.clientRoot, roots.serverRoot, mod);
});

ipcMain.handle("rename-mod", (_event, modId: string, alias: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  return setModAlias(sptPath, modId, alias);
});

ipcMain.handle("open-mod-folder", (_event, mod: ModInfo, target: InstanceId = "main") => {
  const roots = rootsFor(target);
  if (!roots) return { success: false, message: `No ${target} instance configured.` };

  const modPath = resolveModPath(roots.clientRoot, roots.serverRoot, mod);
  if (!fs.existsSync(modPath)) {
    return { success: false, message: "Mod path not found: " + modPath };
  }
  if (fs.statSync(modPath).isDirectory()) {
    shell.openPath(modPath);
  } else {
    shell.showItemInFolder(modPath);
  }
  return { success: true, message: "Folder opened." };
});

ipcMain.handle("export-mod-list", async () => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };

  const data = exportModListData(sptPath, getServerRoot()!);
  const result = await dialog.showSaveDialog({
    defaultPath: "spt-modlist.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) return { success: false, message: "Cancelled." };

  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), "utf-8");
  return { success: true, message: `Exported list with ${data.mods.length} mod(s) to ${path.basename(result.filePath)}.` };
});

ipcMain.handle("import-mod-list", async () => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };

  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false, message: "Cancelled." };

  try {
    const raw = fs.readFileSync(result.filePaths[0], "utf-8");
    const parsed = JSON.parse(raw);
    const names: string[] = Array.isArray(parsed.mods)
      ? parsed.mods.map((m: { name?: string }) => m.name).filter((n: unknown): n is string => typeof n === "string")
      : [];
    if (names.length === 0) {
      return { success: false, message: "That file doesn't look like a mod list exported by this app." };
    }
    // Pass through the GUIDs from the list (where present) so restoring matches by exact
    // identifier instead of guessing from the folder name.
    const guidByName: Record<string, string> = {};
    for (const entry of parsed.mods as { name?: string; guid?: string }[]) {
      if (typeof entry?.name === "string" && typeof entry?.guid === "string") {
        guidByName[entry.name] = entry.guid;
      }
    }
    const comparison = compareModList(sptPath, getServerRoot()!, names);
    return {
      success: true,
      message: `Compared against ${names.length} mod(s) from the imported list.`,
      comparison,
      guidByName
    };
  } catch (err) {
    return { success: false, message: "Error reading the file: " + (err as Error).message };
  }
});