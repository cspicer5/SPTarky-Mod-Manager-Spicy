export type ModType = "server" | "client" | "hybrid" | "unknown";

export interface ModInfo {
  id: string;
  name: string;
  originalName: string;
  type: ModType;
  enabled: boolean;
  installedManually: boolean;
  loadOrder: number;
  version?: string;
  versionFromSibling?: boolean; // inferred from another part of the same package
  author?: string;
  installedAt?: string;
  manifestOnly?: boolean;
  sptVersion?: string; // SPT version constraint declared by the mod (read from the DLL)
  sptCompatibility?: "compatible" | "incompatible" | "unknown"; // declared constraint vs. this instance's version
  packageId?: string; // parts installed from the same archive share this id
  packageInferred?: boolean; // joined its package by name similarity, not by an install record
  packageSiblings?: { id: string; type: ModType }[]; // the other parts, when the package is inferred
  guid?: string; // GUID declared by the mod (SPT 4.0) — exact match against Forge
  linkedModName?: string;
}

export interface ModListComparison {
  missing: string[];
  extra: string[];
}

export interface ConflictReport {
  clientFileConflicts: { fileName: string; mods: string[] }[];
  duplicateServerNames: { declaredName: string; mods: string[] }[];
  duplicateClientMods?: { declaredName: string; mods: string[] }[];
}

export interface ForgeUpdateItem {
  name: string;
  originalName?: string;
  currentVersion?: string;
  recommendedVersion?: string;
  downloadLink?: string;
  guid?: string; // identificador da Forge, gravado ao atualizar pelo app
  reason?: string;
}

/** A Forge match the app arrived at by guesswork and will not act on unconfirmed. */
export interface ForgeUnconfirmedMatch {
  name: string;
  originalName: string;
  modId: number;
  forgeName?: string;
  method: string;
  detailUrl: string;
}

export interface ForgeUpdateCheckResult {
  sptVersionUsed: string;
  updates: ForgeUpdateItem[];
  blocked: ForgeUpdateItem[];
  upToDate: ForgeUpdateItem[];
  incompatible: ForgeUpdateItem[];
  infoOnly: ForgeUpdateItem[];
  unmatched: string[];
  skippedByBudget?: string[];
  unconfirmed?: ForgeUnconfirmedMatch[];
}

export interface ForgeSptVersion {
  version: string;
  modCount: number;
}

export interface ForgeStatusCacheEntry {
  name: string;
  status: "update" | "blocked" | "incompatible" | "info";
  version?: string;
}

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

export interface InstallResult {
  success: boolean;
  message: string;
  needsConfirmation?: boolean;
  tmpDir?: string;
  rootEntries?: string[];
  archivePath?: string;
}

export interface AppUpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadPageUrl?: string;
  releaseUrl?: string;
  releaseName?: string;
}

/** Which install an action applies to. See electron/types.ts for what distinguishes them. */
export type InstanceId = "main" | "headless";

/** How suitable a mod is for a Fika headless client. */
export type HeadlessClass = "required" | "recommended" | "optional" | "unnecessary" | "unknown" | "server-only";

/**
 * What a verdict rests on. Shown in the UI, because "Fika's wiki names this mod" and "its
 * Forge category is Audio" are not claims of equal strength.
 */
export type HeadlessVerdictSource = "manual" | "structural" | "rule" | "pairing" | "category" | "none";

export interface HeadlessVerdict {
  klass: HeadlessClass;
  source: HeadlessVerdictSource;
  why: string;
  menuRisk?: boolean;
  config?: string;
}

export type ParityIssue =
  | "version-drift"
  | "missing-required"
  | "missing-recommended"
  | "headless-only"
  | "server-mod-in-headless"
  | "unnecessary-menu-risk";

export interface ParityRow {
  /** Collision-safe row identity, scoped by side (server: / client:). */
  key: string;
  /** Plain normalised mod name — manual overrides apply to a mod, not to a side. */
  modKey: string;
  name: string;
  type: ModType;
  mainVersion?: string;
  headlessVersion?: string;
  presence: "both" | "main-only" | "headless-only";
  verdict: HeadlessVerdict;
  issue?: ParityIssue;
  detail?: string;
}

export interface ParityReport {
  rows: ParityRow[];
  counts: {
    aligned: number;
    versionDrift: number;
    missingOnHeadless: number;
    headlessOnly: number;
    needsReview: number;
  };
}

/* --- live SPT server ------------------------------------------------------- */

export type ServerSyncIssue =
  | "missing-locally"
  | "outdated-locally"
  | "newer-locally"
  | "not-on-server"
  | "unknown-local-version";

export interface ServerSyncRow {
  key: string;
  /** Local folder name when matched, otherwise whatever the server declares. */
  name: string;
  /** The server's own name, kept only when it differs (Fika's server half calls itself "server"). */
  serverName?: string;
  guid?: string;
  author?: string;
  serverVersion?: string;
  localVersion?: string;
  localModId?: string;
  issue?: ServerSyncIssue;
  /** GUID matches are exact; name matches are a weaker fallback and are shown as such. */
  matchedBy?: "guid" | "name";
  url?: string;
  detail?: string;
}

export interface ServerSyncReport {
  reachable: boolean;
  url: string;
  sptVersion?: string;
  localSptVersion?: string;
  sptMatches?: boolean;
  error?: string;
  fetchedAt: string;
  fikaRequired: string[];
  fikaOptional: string[];
  rows: ServerSyncRow[];
  counts: {
    inSync: number;
    needUpdating: number;
    needInstalling: number;
    newerLocally: number;
    notOnServer: number;
    unknownVersion: number;
  };
  readyToPlay: boolean;
}

export interface HeadlessView {
  configured: boolean;
  headlessPath?: string;
  mainMods?: ModInfo[];
  headlessMods?: ModInfo[];
  parity?: ParityReport;
}

export interface AppRelease {
  tag: string;
  version: string;
  name: string;
  publishedAt?: string;
  notes?: string;
  assetUrl?: string;
  assetName?: string;
  assetSize?: number;
  prerelease: boolean;
  isCurrent: boolean;
}

export interface ModManagerAPI {
  getSptPath: () => Promise<{ path: string; serverRoot: string; split: boolean } | null>;
  selectSptFolder: () => Promise<{ success: boolean; path?: string; serverRoot?: string; split?: boolean; message?: string }>;
  openModHub: () => Promise<void>;
  scanMods: (target?: InstanceId) => Promise<ModInfo[]>;
  installMod: () => Promise<InstallResult>;
  installModFromPath: (filePath: string) => Promise<InstallResult>;
  toggleMod: (mod: ModInfo, target?: InstanceId) => Promise<{ success: boolean; message: string }>;
  uninstallMod: (mod: ModInfo, target?: InstanceId) => Promise<{ success: boolean; message: string }>;
  renameMod: (modId: string, alias: string) => Promise<{ success: boolean; message: string }>;
  openModFolder: (mod: ModInfo, target?: InstanceId) => Promise<{ success: boolean; message: string }>;

  // --- Fika headless client ---
  getHeadlessPath: () => Promise<string | null>;
  selectHeadlessFolder: () => Promise<{ success: boolean; path?: string; message?: string }>;
  clearHeadlessPath: () => Promise<{ success: boolean }>;
  getHeadlessView: () => Promise<HeadlessView>;
  getHeadlessAdvice: () => Promise<{ id: string; verdict: HeadlessVerdict }[]>;
  setHeadlessOverride: (modKey: string, klass: HeadlessClass | null) => Promise<{ success: boolean; message?: string }>;

  // --- headless sync (main -> headless only; the main install is the source of truth) ---
  syncModToHeadless: (mod: ModInfo) => Promise<{ success: boolean; message: string }>;
  removeModFromHeadless: (mod: ModInfo) => Promise<{ success: boolean; message: string }>;
  syncAllToHeadless: () => Promise<{ success: boolean; message: string; copied?: number }>;

  // --- live SPT server (remote, READ-ONLY — there is deliberately no write method) ---
  getServerUrl: () => Promise<string | null>;
  setServerUrl: (url: string) => Promise<{ success: boolean; url?: string; message?: string }>;
  clearServerUrl: () => Promise<{ success: boolean }>;
  getServerSync: () => Promise<{ configured: boolean; report?: ServerSyncReport }>;
  exportModList: () => Promise<{ success: boolean; message: string }>;
  importModList: () => Promise<{
    success: boolean;
    message: string;
    comparison?: ModListComparison;
    guidByName?: Record<string, string>;
  }>;
  getSptVersion: () => Promise<string | undefined>;
  detectConflicts: () => Promise<ConflictReport>;
  getSptSemver: () => Promise<string | undefined>;
  getSptVersionOverride: () => Promise<string | null>;
  setSptVersionOverride: (value: string) => Promise<void>;
  getForgeSptVersions: () => Promise<ForgeSptVersion[]>;
  getForgeCache: () => Promise<{ statusCache: ForgeStatusCacheEntry[] | null; checkedAt: string | null }>;
  setForgeCache: (statusCache: ForgeStatusCacheEntry[]) => Promise<void>;
  checkForgeUpdates: (
    mods: { name: string; originalName: string; version?: string; guid?: string; packageId?: string; packageInferred?: boolean }[],
    sptVersion: string
  ) => Promise<{ success: boolean; result?: ForgeUpdateCheckResult; message?: string }>;
  /** Pins a mod to a Forge id by hand. Overrides automatic matching permanently. */
  setForgeMatch: (originalName: string, modId: number) => Promise<{ success: boolean; message?: string }>;
  /** Removes a manual pin, returning the mod to automatic matching. */
  clearForgeMatch: (originalName: string) => Promise<{ success: boolean; message?: string }>;
  /** "I already have this version" — stops this exact version being offered again. */
  dismissForgeUpdate: (originalName: string, version: string) => Promise<{ success: boolean; message?: string }>;
  /** Undoes a dismissal. */
  undismissForgeUpdate: (originalName: string) => Promise<{ success: boolean; message?: string }>;
  searchForgeMods: (params: {
    query?: string;
    categorySlug?: string;
    sptVersionConstraint?: string;
    sort?: string;
    page?: number;
  }) => Promise<{ success: boolean; result?: ForgeSearchResult; message?: string }>;
  getForgeCategories: () => Promise<ForgeCategory[]>;
  checkAppUpdate: () => Promise<AppUpdateInfo>;
  listAppReleases: () => Promise<{ releases: AppRelease[]; error?: string }>;
  installAppRelease: (tag: string) => Promise<{ success: boolean; message: string }>;
  onAppUpdateProgress: (callback: (data: { received: number; total: number }) => void) => () => void;
  onForgeCheckProgress: (callback: (data: { done: number; total: number }) => void) => () => void;
  openReleasePage: (url: string) => Promise<{ success: boolean }>;
  findForgeDownloadsForNames: (
    entries: { name: string; guid?: string }[]
  ) => Promise<Record<string, { downloadLink: string; version?: string; forgeName?: string; guid?: string }>>;
  findForgeDownloadForName: (
    name: string,
    sptVersion?: string
  ) => Promise<{ found: boolean; downloadLink?: string; version?: string; forgeName?: string }>;
  installForgeMod: (
    jobId: string,
    downloadLink: string,
    suggestedName: string,
    forgeInfo?: { name?: string; author?: string; version?: string; guid?: string }
  ) => Promise<InstallResult>;
  onDownloadProgress: (callback: (data: { jobId: string; receivedBytes: number; totalBytes: number }) => void) => () => void;
  confirmUnrecognizedInstall: (tmpDir: string, archivePath: string) => Promise<InstallResult>;
  abortUnrecognizedInstall: (tmpDir: string) => Promise<{ success: boolean; message: string }>;
}

declare global {
  interface Window {
    modManagerAPI: ModManagerAPI;
  }
}