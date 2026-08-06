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