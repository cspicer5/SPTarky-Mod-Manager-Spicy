import { contextBridge, ipcRenderer } from "electron";
import { ModInfo } from "./types";

contextBridge.exposeInMainWorld("modManagerAPI", {
  getSptPath: () => ipcRenderer.invoke("get-spt-path"),
  selectSptFolder: () => ipcRenderer.invoke("select-spt-folder"),
  openModHub: () => ipcRenderer.invoke("open-mod-hub"),
  scanMods: (target?: "main" | "headless") => ipcRenderer.invoke("scan-mods", target ?? "main"),
  installMod: () => ipcRenderer.invoke("install-mod"),
  installModFromPath: (filePath: string) => ipcRenderer.invoke("install-mod-from-path", filePath),
  toggleMod: (mod: ModInfo, target?: "main" | "headless") => ipcRenderer.invoke("toggle-mod", mod, target ?? "main"),
  uninstallMod: (mod: ModInfo, target?: "main" | "headless") => ipcRenderer.invoke("uninstall-mod", mod, target ?? "main"),
  renameMod: (modId: string, alias: string) => ipcRenderer.invoke("rename-mod", modId, alias),
  openModFolder: (mod: ModInfo, target?: "main" | "headless") =>
    ipcRenderer.invoke("open-mod-folder", mod, target ?? "main"),

  // --- Fika headless client ---
  getHeadlessPath: () => ipcRenderer.invoke("get-headless-path"),
  selectHeadlessFolder: () => ipcRenderer.invoke("select-headless-folder"),
  clearHeadlessPath: () => ipcRenderer.invoke("clear-headless-path"),
  getHeadlessView: () => ipcRenderer.invoke("get-headless-view"),
  getHeadlessAdvice: () => ipcRenderer.invoke("get-headless-advice"),
  setHeadlessOverride: (modKey: string, klass: string | null) =>
    ipcRenderer.invoke("set-headless-override", modKey, klass),

  // --- bulk reinstall ---
  previewBulkReinstall: () => ipcRenderer.invoke("preview-bulk-reinstall"),
  runBulkReinstall: (opts: { sptVersion?: string }) => ipcRenderer.invoke("run-bulk-reinstall", opts),
  onBulkReinstallProgress: (callback: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown) => callback(p);
    ipcRenderer.on("bulk-reinstall-progress", handler);
    return () => ipcRenderer.removeListener("bulk-reinstall-progress", handler);
  },

  // --- mod presets (local) ---
  listPresets: () => ipcRenderer.invoke("list-presets"),
  createPreset: (opts: { name: string; description?: string; optional?: string[] }) =>
    ipcRenderer.invoke("create-preset", opts),
  updatePreset: (id: string) => ipcRenderer.invoke("update-preset", id),
  renamePreset: (id: string, name: string, description?: string) =>
    ipcRenderer.invoke("rename-preset", id, name, description),
  deletePreset: (id: string) => ipcRenderer.invoke("delete-preset", id),
  getPresetReport: (id: string) => ipcRenderer.invoke("get-preset-report", id),
  applyPresetState: (id: string) => ipcRenderer.invoke("apply-preset-state", id),

  // --- headless sync (main -> headless only) ---
  syncModToHeadless: (mod: ModInfo) => ipcRenderer.invoke("sync-mod-to-headless", mod),
  removeModFromHeadless: (mod: ModInfo) => ipcRenderer.invoke("remove-mod-from-headless", mod),
  syncAllToHeadless: () => ipcRenderer.invoke("sync-all-to-headless"),

  // --- live SPT server (remote, read-only: no write methods exposed) ---
  getServerUrl: () => ipcRenderer.invoke("get-server-url"),
  setServerUrl: (url: string) => ipcRenderer.invoke("set-server-url", url),
  clearServerUrl: () => ipcRenderer.invoke("clear-server-url"),
  getServerSync: () => ipcRenderer.invoke("get-server-sync"),
  exportModList: () => ipcRenderer.invoke("export-mod-list"),
  importModList: () => ipcRenderer.invoke("import-mod-list"),
  getSptVersion: () => ipcRenderer.invoke("get-spt-version"),
  detectConflicts: () => ipcRenderer.invoke("detect-conflicts"),
  getSptSemver: () => ipcRenderer.invoke("get-spt-semver"),
  getSptVersionOverride: () => ipcRenderer.invoke("get-spt-version-override"),
  setSptVersionOverride: (value: string) => ipcRenderer.invoke("set-spt-version-override", value),
  getForgeSptVersions: () => ipcRenderer.invoke("get-forge-spt-versions"),
  getForgeCache: () => ipcRenderer.invoke("get-forge-cache"),
  setForgeCache: (statusCache: { name: string; status: string; version?: string }[]) =>
    ipcRenderer.invoke("set-forge-cache", statusCache),
  checkForgeUpdates: (mods: { name: string; originalName: string; version?: string; guid?: string }[], sptVersion: string) =>
    ipcRenderer.invoke("check-forge-updates", mods, sptVersion),
  searchForgeMods: (params: { query?: string; categorySlug?: string; sptVersionConstraint?: string; sort?: string; page?: number }) =>
    ipcRenderer.invoke("search-forge-mods", params),
  getForgeCategories: () => ipcRenderer.invoke("get-forge-categories"),
  setForgeMatch: (originalName: string, modId: number) => ipcRenderer.invoke("set-forge-match", originalName, modId),
  clearForgeMatch: (originalName: string) => ipcRenderer.invoke("clear-forge-match", originalName),
  dismissForgeUpdate: (originalName: string, version: string) =>
    ipcRenderer.invoke("dismiss-forge-update", originalName, version),
  undismissForgeUpdate: (originalName: string) => ipcRenderer.invoke("undismiss-forge-update", originalName),
  checkAppUpdate: () => ipcRenderer.invoke("check-app-update"),
  listAppReleases: () => ipcRenderer.invoke("list-app-releases"),
  installAppRelease: (tag: string) => ipcRenderer.invoke("install-app-release", tag),
  onAppUpdateProgress: (callback: (data: { received: number; total: number }) => void) => {
    const handler = (_e: unknown, data: { received: number; total: number }) => callback(data);
    ipcRenderer.on("app-update-progress", handler);
    return () => ipcRenderer.removeListener("app-update-progress", handler);
  },
  onForgeCheckProgress: (callback: (data: { done: number; total: number }) => void) => {
    const handler = (_e: unknown, data: { done: number; total: number }) => callback(data);
    ipcRenderer.on("forge-check-progress", handler);
    return () => ipcRenderer.removeListener("forge-check-progress", handler);
  },
  openReleasePage: (url: string) => ipcRenderer.invoke("open-release-page", url),
  findForgeDownloadsForNames: (entries: { name: string; guid?: string }[]) =>
    ipcRenderer.invoke("find-forge-downloads-for-names", entries),
  findForgeDownloadForName: (name: string, sptVersion?: string) =>
    ipcRenderer.invoke("find-forge-download-for-name", name, sptVersion),
  installForgeMod: (
    jobId: string,
    downloadLink: string,
    suggestedName: string,
    forgeInfo?: { name?: string; author?: string; version?: string; guid?: string }
  ) => ipcRenderer.invoke("install-forge-mod", jobId, downloadLink, suggestedName, forgeInfo),
  confirmUnrecognizedInstall: (tmpDir: string, archivePath: string) =>
    ipcRenderer.invoke("install-mod-confirm", tmpDir, archivePath),
  abortUnrecognizedInstall: (tmpDir: string) => ipcRenderer.invoke("install-mod-abort", tmpDir),
  onDownloadProgress: (callback: (data: { jobId: string; receivedBytes: number; totalBytes: number }) => void) => {
    const handler = (_event: unknown, data: { jobId: string; receivedBytes: number; totalBytes: number }) => callback(data);
    ipcRenderer.on("download-progress", handler);
    return () => ipcRenderer.removeListener("download-progress", handler);
  }
});