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
  undismissForgeUpdate
} from "./modManager";
import { InstanceConfig, ModInfo } from "./types";

const MOD_HUB_URL = "https://hub.sp-tarkov.com/";

const store = new Store<InstanceConfig>({
  defaults: { sptPath: null, serverRoot: null, sptVersionOverride: null, forgeStatusCache: null, forgeCheckedAt: null }
});

// The stored sptPath is always the CLIENT root. serverRoot equals sptPath in the vast
// majority of instances; it only differs on a "split" install (the SPT 4.x installer can
// create a separate subfolder for the server). The fallback here covers configs saved
// before that change, where serverRoot was never set.
function getServerRoot(): string | null {
  return store.get("serverRoot") || store.get("sptPath");
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
ipcMain.handle("scan-mods", () => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return [];
  // Compatibility is computed here (not during the scan) because it depends on the SPT
  // version CHOSEN by the user, which the backend only knows via the store. Doing it here
  // avoids duplicating the version-comparison logic in the renderer process.
  const instanceVersion = store.get("sptVersionOverride") ?? detectSptSemver(sptPath);
  return scanMods(sptPath, getServerRoot()!).map((mod) => ({
    ...mod,
    sptCompatibility: checkSptCompatibility(mod.sptVersion, instanceVersion ?? undefined)
  }));
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

ipcMain.handle("toggle-mod", (_event, mod: ModInfo) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  return toggleMod(sptPath, getServerRoot()!, mod);
});

ipcMain.handle("uninstall-mod", (_event, mod: ModInfo) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  return uninstallMod(sptPath, getServerRoot()!, mod);
});

ipcMain.handle("rename-mod", (_event, modId: string, alias: string) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };
  return setModAlias(sptPath, modId, alias);
});

ipcMain.handle("open-mod-folder", (_event, mod: ModInfo) => {
  const sptPath = store.get("sptPath");
  if (!sptPath) return { success: false, message: "No SPT instance configured." };

  const target = resolveModPath(sptPath, getServerRoot()!, mod);
  if (!fs.existsSync(target)) {
    return { success: false, message: "Mod path not found: " + target };
  }
  if (fs.statSync(target).isDirectory()) {
    shell.openPath(target);
  } else {
    shell.showItemInFolder(target);
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