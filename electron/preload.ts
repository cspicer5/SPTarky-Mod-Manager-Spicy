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

  // --- installing from GitHub (the route that outlives Forge) ---
  githubListReleases: (repoOrUrl: string) => ipcRenderer.invoke("github-list-releases", repoOrUrl),
  githubInstallRelease: (args: {
    jobId: string;
    assetUrl: string;
    assetName: string;
    repo: string;
    version: string;
    releaseUrl?: string;
  }) => ipcRenderer.invoke("github-install-release", args),

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
  // What a sync WOULD do, so the user confirms against real numbers rather than a promise.
  planPresetSync: (id: string, fromStore?: boolean) => ipcRenderer.invoke("plan-preset-sync", id, fromStore),
  syncInstallToPreset: (id: string, fromStore?: boolean) => ipcRenderer.invoke("sync-install-to-preset", id, fromStore),
  onPresetSyncProgress: (callback: (p: any) => void) => {
    const handler = (_e: unknown, p: any) => callback(p);
    ipcRenderer.on("preset-sync-progress", handler);
    return () => ipcRenderer.removeListener("preset-sync-progress", handler);
  },

  // --- the shared preset store (a folder: LAN share, VPN path, or synced directory) ---
  getPresetStoreStatus: () => ipcRenderer.invoke("get-preset-store-status"),
  getPresetIdentity: () => ipcRenderer.invoke("get-preset-identity"),
  setPresetIdentity: (name: string) => ipcRenderer.invoke("set-preset-identity", name),
  choosePresetStore: () => ipcRenderer.invoke("choose-preset-store"),
  disconnectPresetStore: () => ipcRenderer.invoke("disconnect-preset-store"),
  createPresetStore: (name: string, writePolicy: "curated" | "shared") =>
    ipcRenderer.invoke("create-preset-store", name, writePolicy),
  setPresetStorePolicy: (policy: "curated" | "shared") => ipcRenderer.invoke("set-preset-store-policy", policy),
  // overwrite is the user's answer to "this would replace someone else's preset", so it is
  // always an explicit second call, never a default.
  publishPreset: (id: string, overwrite?: boolean) => ipcRenderer.invoke("publish-preset", id, overwrite),
  unpublishPreset: (id: string) => ipcRenderer.invoke("unpublish-preset", id),
  importPreset: (id: string, overwrite?: boolean) => ipcRenderer.invoke("import-preset", id, overwrite),
  getStorePresetReport: (id: string) => ipcRenderer.invoke("get-store-preset-report", id),

  // --- addons: compatibility and companion mods (v1.2.2) ---
  getAddonSuggestions: () => ipcRenderer.invoke("get-addon-suggestions"),
  forgetAddon: (forgeAddonId?: number, name?: string) => ipcRenderer.invoke("forget-addon", forgeAddonId, name),
  // Reads the installed assemblies, so it is deliberately on demand rather than part of a scan.
  detectAddonLinks: () => ipcRenderer.invoke("detect-addon-links"),
  setAddonParent: (id: string, type: "server" | "client", parentName: string | null) =>
    ipcRenderer.invoke("set-addon-parent", id, type, parentName),
  // No version argument: which build fits is a function of the PARENT's installed version,
  // and only the main process knows that.
  installForgeAddon: (jobId: string, addonId: number) => ipcRenderer.invoke("install-forge-addon", jobId, addonId),
  installAddonFromFile: (parentName: string, filePath?: string) =>
    ipcRenderer.invoke("install-addon-from-file", parentName, filePath),
  installAddonFromGithub: (args: {
    jobId: string;
    parentName: string;
    assetUrl: string;
    assetName: string;
    repo: string;
    version: string;
  }) => ipcRenderer.invoke("install-addon-from-github", args),

  // --- preset payloads: the store carries the mod files, so no Forge is needed ---
  publishPresetWithPayloads: (id: string, overwrite?: boolean) =>
    ipcRenderer.invoke("publish-preset-with-payloads", id, overwrite),
  // names omitted = install everything the preset carries that is missing here
  installPresetPayloads: (id: string, names?: string[]) => ipcRenderer.invoke("install-preset-payloads", id, names),
  verifyPresetPayloads: (id: string, deep?: boolean) => ipcRenderer.invoke("verify-preset-payloads", id, deep),
  cancelPresetPayloads: () => ipcRenderer.invoke("cancel-preset-payloads"),
  getStoreUsage: () => ipcRenderer.invoke("get-store-usage"),
  cleanStorePayloads: () => ipcRenderer.invoke("clean-store-payloads"),
  onPresetPayloadProgress: (callback: (p: any) => void) => {
    const handler = (_e: unknown, p: any) => callback(p);
    ipcRenderer.on("preset-payload-progress", handler);
    return () => ipcRenderer.removeListener("preset-payload-progress", handler);
  },

  // --- preset files: sharing with no store at all ---
  exportPresetFile: (id: string) => ipcRenderer.invoke("export-preset-file", id),
  // knownPath is the file already chosen on the first call, so confirming an overwrite does
  // not make the user find it in the dialog a second time.
  importPresetFile: (overwrite?: boolean, knownPath?: string) =>
    ipcRenderer.invoke("import-preset-file", overwrite, knownPath),

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
  // A pasted mod page URL is now slug-based, so turning it into an id needs a lookup.
  resolveModRef: (input: string) => ipcRenderer.invoke("resolve-mod-ref", input),
  // folder name -> catalogue mod id, from the match cache (confirmed identities only).
  getInstalledCatalogueIds: () => ipcRenderer.invoke("get-installed-catalogue-ids"),
  // What one mod needs, and what the whole install is missing.
  checkModDependencies: (modId: number, version: string) =>
    ipcRenderer.invoke("check-mod-dependencies", modId, version),
  checkAllDependencies: () => ipcRenderer.invoke("check-all-dependencies"),
  getRegistrySource: () => ipcRenderer.invoke("get-registry-source"),
  setRegistrySource: (value: string | null) => ipcRenderer.invoke("set-registry-source", value),
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
  findForgeDownloadForName: (name: string, sptVersion?: string, guid?: string) =>
    ipcRenderer.invoke("find-forge-download-for-name", name, sptVersion, guid),
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
  },

  // Bundle sync: verifying the cache and pulling what is missing.
  checkBundles: () => ipcRenderer.invoke("check-bundles"),
  syncBundles: () => ipcRenderer.invoke("sync-bundles"),
  cancelBundleSync: () => ipcRenderer.invoke("cancel-bundle-sync"),
  onBundleProgress: (
    callback: (data: { phase: "verify" | "download"; done: number; total: number; bytes?: number; current?: string }) => void
  ) => {
    const handler = (_event: unknown, data: any) => callback(data);
    ipcRenderer.on("bundle-progress", handler);
    return () => ipcRenderer.removeListener("bundle-progress", handler);
  }
});