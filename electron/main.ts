import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import path from "path";
import fs from "fs";
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
import { InstanceConfig, InstanceId, ModInfo } from "./types";

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
    forgeCheckedAt: null
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
  return scanMods(roots.clientRoot, roots.serverRoot).map((mod) => ({
    ...mod,
    sptCompatibility: checkSptCompatibility(mod.sptVersion, instanceVersion ?? undefined)
  }));
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