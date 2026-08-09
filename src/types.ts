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
  /** Where this mod's code lives — the route to update checks once Forge is gone. */
  sourceUrl?: string;
  /** "owner/repo" when the source is GitHub. */
  sourceRepo?: string;
  /**
   * Where `version` came from. "recorded" is the strongest — what the app actually installed,
   * with the files unchanged since — and it outranks the mod's own declaration, because
   * several authors never update theirs (Fika's server mod declares 2.0.9 whatever you have).
   */
  versionSource?: "recorded" | "sibling" | "assembly" | "stale-record";
  versionOrigin?: "forge" | "github" | "archive-name" | "declared-at-install";
  versionEvidence?: string;
  /** Present only when the recorded and declared versions disagree. */
  declaredVersion?: string;
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

/**
 * A dependency, and whether it is a problem.
 *
 * `status` is about what is installed; `conflict` is about the requested SET disagreeing on a
 * version, so the two are independent — a dependency can be present AND contested.
 */
export interface DependencyReport {
  modId: number;
  guid?: string;
  name: string;
  slug?: string;
  status: "satisfied" | "missing" | "outdated" | "no-compatible-build";
  conflict: boolean;
  installedVersion?: string;
  version?: string;
  downloadLink?: string;
  bytes?: number;
  transitive: boolean;
  via?: string;
}

export interface DependencyCheck {
  reports: DependencyReport[];
  missing: DependencyReport[];
  outdated: DependencyReport[];
  unavailable: DependencyReport[];
  conflicts: DependencyReport[];
  /** The catalogue had no answer — NOT the same as "nothing is missing". */
  unknown: boolean;
  error?: string;
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
  /** The GitHub release — changelog and download both, since the zip is attached to it. */
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
  /** Compatibility addons and what they mean for the headless side. */
  addons?: AddonParityRow[];
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

/**
 * What an addon means for the headless client.
 *
 * A compatibility patch must exist wherever both mods it reconciles do, or the pair breaks on
 * one side only. Server-side patches are structurally irrelevant: a headless client has no
 * server and never loads user/mods.
 */
export interface AddonParityRow {
  name: string;
  parentName: string;
  parentType: ModType;
  mergedIntoParent: boolean;
  needsHeadless: boolean;
  parentOnHeadless: boolean;
  status: "carried-with-parent" | "parent-missing" | "not-applicable" | "needs-attention";
  detail: string;
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

/* --- GitHub as a mod source ------------------------------------------------- */

export interface GithubAsset {
  name: string;
  url: string;
  size: number;
}

export interface GithubReleaseDetail {
  tag: string;
  version: string;
  name: string;
  publishedAt?: string;
  prerelease: boolean;
  notes?: string;
  assets: GithubAsset[];
}

/* --- bulk reinstall --------------------------------------------------------- */

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

/* --- mod presets ----------------------------------------------------------- */

export interface PresetMod {
  name: string;
  guid?: string;
  version?: string;
  versionSource?: ModInfo["versionSource"];
  type: ModType;
  enabled: boolean;
  loadOrder: number;
  required: boolean;
  author?: string;
  /* --- phase 3: set only when the preset carries this mod's files --------- */
  /** Key into the store's mods/ directory. Absent means "named, not carried". */
  payload?: string;
  payloadHash?: string;
  sizeBytes?: number;
  license?: string;
  sourceUrl?: string;
  /* --- addons (v1.2.2): the relationship travels with the preset --------- */
  addonOf?: string;
  addonOfType?: ModType;
  forgeAddonId?: number;
  addonParentConstraint?: string;
}

/**
 * An addon a preset carries, recorded separately from the mod list because most addons unpack
 * into their parent's folder and have no mod row of their own.
 */
export interface PresetAddon {
  name: string;
  forgeAddonId?: number;
  version?: string;
  parentName: string;
  parentType: ModType;
  parentConstraint?: string;
  source: "forge" | "github" | "file";
  mergedIntoParent: boolean;
  folders?: { id: string; type: ModType }[];
}

export interface PresetAddonRow {
  name: string;
  forgeAddonId?: number;
  version?: string;
  parentName: string;
  parentType: ModType;
  parentConstraint?: string;
  mergedIntoParent: boolean;
  status: "present" | "missing" | "parent-missing";
  detail?: string;
}

export interface Preset {
  schema: number;
  id: string;
  name: string;
  description?: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  sptVersion?: string;
  hasPayloads: boolean;
  /** Present when this was imported from a shared store rather than captured here. */
  origin?: { store: string; path: string; author?: string; importedAt: string };
  mods: PresetMod[];
  /** Compatibility addons in this setup, most of which have no mod row of their own. */
  addons?: PresetAddon[];
}

/* --- the shared store ---------------------------------------------------- */

/**
 * Who may publish. A convention between clients, not a security control — it lives in a file
 * anyone with write access to the folder can edit. The share's own permissions are the real
 * enforcement, and the UI says so.
 */
export type WritePolicy = "curated" | "shared";

export interface PresetStoreInfo {
  schema: number;
  name: string;
  writePolicy: WritePolicy;
  owner: string;
  createdAt: string;
}

export interface StoreEntry {
  preset: Preset;
  file: string;
  /** Other files claiming the same id — what a sync tool leaves behind after a conflict. */
  conflictsWith?: string[];
}

export interface PresetStoreStatus {
  path: string;
  connected: boolean;
  info?: PresetStoreInfo;
  entries: StoreEntry[];
  canPublish: boolean;
  publishBlockedReason?: string;
  message?: string;
}

/* --- addons: compatibility and companion mods (v1.2.2) -------------------- */

export interface AddonVersion {
  version: string;
  link?: string;
  bytes?: number;
  /** Semver range against the PARENT mod's version, e.g. "~2.7.0". */
  modConstraint?: string;
  publishedAt?: string;
}

export interface ForgeAddon {
  id: number;
  name: string;
  slug?: string;
  teaser?: string;
  description?: string;
  owner?: string;
  downloads?: number;
  detailUrl?: string;
  modId?: number;
  isDetached?: boolean;
  versions: AddonVersion[];
}

export interface AddonSuggestion {
  addon: ForgeAddon;
  parentName: string;
  parentType: ModType;
  parentVersion?: string;
  pick?: AddonVersion;
  /**
   * "declared" — a build states it fits this parent version.
   * "unconstrained" — a build exists but says nothing about which parents it suits.
   * "none" — the addon exists but no build supports the parent version installed.
   */
  fit: "declared" | "unconstrained" | "none";
  installed: boolean;
}

/**
 * An addon this app installed.
 *
 * Kept separately from the mod list because most addons unpack into their PARENT's folder and
 * never appear as a mod of their own — which is why "did I already install this?" cannot be
 * answered by looking at folders.
 */
export interface InstalledAddonRecord {
  forgeAddonId?: number;
  name: string;
  version?: string;
  parentName: string;
  parentType: ModType;
  parentConstraint?: string;
  installedAt: string;
  source: "forge" | "github" | "file";
  folders: { id: string; type: ModType }[];
  /** True when it has no folder of its own, so it cannot be uninstalled separately. */
  mergedIntoParent: boolean;
  /**
   * Its parent was reinstalled afterwards, which replaced the folder and took this addon's
   * files with it — silently, since nothing about the parent's own row changes.
   */
  needsReinstall?: boolean;
}

export interface AddonLink {
  name: string;
  type: ModType;
  guid: string;
  parentName?: string;
  parentType?: ModType;
  method: "manual" | "declared-guid" | "same-archive";
}

/** A mod something installed knows how to work with, that isn't installed here. */
export interface AddonIntegration {
  name: string;
  type: ModType;
  guid: string;
  forgeId: number;
  forgeName: string;
}

/* --- syncing an install to a preset ---------------------------------------- */

/**
 * Where a mod would come from. Payload is strongest (exact bytes, no network, survives the
 * Forge shutdown); "none" means nothing can supply it and the user is told rather than
 * left with a silent gap.
 */
export type SyncSource = "payload" | "github" | "forge" | "none";

export interface SyncStep {
  name: string;
  type: ModType;
  reason: "missing" | "version-mismatch" | "state-mismatch" | "addon-missing";
  source: SyncSource;
  wantVersion?: string;
  haveVersion?: string;
  wantEnabled?: boolean;
  sourceUrl?: string;
  parentName?: string;
  blockedReason?: string;
}

export interface SyncPlan {
  steps: SyncStep[];
  actionable: SyncStep[];
  blocked: SyncStep[];
  counts: { install: number; update: number; toggle: number; addons: number; blocked: number };
  payloadBytes: number;
}

export interface PresetSyncProgress {
  step: string;
  name: string;
  done: number;
  total: number;
  receivedBytes?: number;
  totalBytes?: number;
}

/* --- payloads (phase 3) --------------------------------------------------- */

export interface StoreUsage {
  payloads: number;
  bytes: number;
  /** Left behind by interrupted copies. Resumable, so not deleted on sight. */
  stagingBytes: number;
}

export interface PayloadVerifyRow {
  name: string;
  ok: boolean;
  key: string;
  /** "deep" re-hashed every byte; "shallow" checked file count and sizes only. */
  depth: "shallow" | "deep";
  message: string;
}

/** Streamed during publish and install, which can run for tens of minutes on a big store. */
export interface PayloadProgress {
  phase: "publish" | "install";
  mod: string;
  file?: string;
  filesDone?: number;
  filesTotal?: number;
  bytesDone: number;
  bytesTotal: number;
  modsDone: number;
  modsTotal: number;
  bytesReused?: number;
}

export type PresetIssue =
  | "missing"
  | "version-mismatch"
  | "state-mismatch"
  | "extra"
  | "unknown-version"
  /** An addon whose parent the preset does not include — incoherent, though it installs fine. */
  | "orphaned-addon";

export interface PresetRow {
  key: string;
  name: string;
  type: ModType;
  guid?: string;
  presetVersion?: string;
  localVersion?: string;
  presetEnabled?: boolean;
  localEnabled?: boolean;
  required: boolean;
  issue?: PresetIssue;
  matchedBy?: "guid" | "name";
  detail?: string;
  /** Set when this row is an addon, so it can be shown under what it attaches to. */
  addonOf?: string;
}

export interface PresetReport {
  presetId: string;
  presetName: string;
  sptVersion?: string;
  localSptVersion?: string;
  sptMatches?: boolean;
  rows: PresetRow[];
  counts: {
    matching: number;
    missing: number;
    missingRequired: number;
    versionMismatch: number;
    stateMismatch: number;
    extra: number;
    unknownVersion: number;
    orphanedAddon: number;
  };
  /** Addons in this preset, by the mod they attach to. */
  addonsByParent?: Record<string, string[]>;
  /** Every addon this preset carries, and whether this install has it. */
  addonRows?: PresetAddonRow[];
  satisfied: boolean;
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

  // --- installing from GitHub (works after Forge shuts down) ---
  githubListReleases: (repoOrUrl: string) => Promise<{ repo?: string; releases: GithubReleaseDetail[]; error?: string }>;
  githubInstallRelease: (args: {
    jobId: string;
    assetUrl: string;
    assetName: string;
    repo: string;
    version: string;
    releaseUrl?: string;
  }) => Promise<InstallResult>;

  // --- bulk reinstall (see electron/bulkReinstall.ts for the safeguards) ---
  previewBulkReinstall: () => Promise<{
    success: boolean;
    modCount?: number;
    withoutRecord?: number;
    withRepo?: number;
    configDirs?: number;
    sptVersion?: string;
    message?: string;
  }>;
  runBulkReinstall: (opts: { sptVersion?: string; source?: "forge" | "github" }) => Promise<{
    success: boolean;
    message: string;
    backupDir?: string;
    outcomes?: BulkReinstallOutcome[];
    counts?: { reinstalled: number; notFound: number; failed: number; skipped: number } | null;
  }>;
  onBulkReinstallProgress: (callback: (p: BulkReinstallProgress) => void) => () => void;

  // --- mod presets (local; see docs/PRESETS.md) ---
  listPresets: () => Promise<Preset[]>;
  createPreset: (opts: { name: string; description?: string; optional?: string[] }) => Promise<{
    success: boolean;
    preset?: Preset;
    message?: string;
  }>;
  updatePreset: (id: string) => Promise<{ success: boolean; preset?: Preset; message?: string }>;
  renamePreset: (id: string, name: string, description?: string) => Promise<{ success: boolean; preset?: Preset; message?: string }>;
  deletePreset: (id: string) => Promise<{ success: boolean; message: string }>;
  getPresetReport: (id: string) => Promise<{ success: boolean; report?: PresetReport; message?: string }>;
  /** Applies only what needs no download: enabling/disabling to match. Never removes mods. */
  applyPresetState: (id: string) => Promise<{ success: boolean; changed?: number; message: string }>;
  /** What a sync would do, so the confirmation shows real numbers. */
  planPresetSync: (
    id: string,
    fromStore?: boolean
  ) => Promise<{ success: boolean; plan?: SyncPlan; summary?: string; presetName?: string; message?: string }>;
  /** Installs, updates and toggles until this install matches. Never removes extra mods. */
  syncInstallToPreset: (
    id: string,
    fromStore?: boolean
  ) => Promise<{
    success: boolean;
    done?: number;
    failed?: { name: string; message: string }[];
    blocked?: { name: string; message: string }[];
    satisfied?: boolean;
    message: string;
  }>;
  onPresetSyncProgress: (callback: (p: PresetSyncProgress) => void) => () => void;

  // --- the shared preset store (phase 2: manifests only) ---
  getPresetStoreStatus: () => Promise<PresetStoreStatus>;
  getPresetIdentity: () => Promise<{ identity: string; explicit: boolean }>;
  setPresetIdentity: (name: string) => Promise<{ success: boolean; identity?: string; message: string }>;
  choosePresetStore: () => Promise<{ success: boolean; cancelled?: boolean; status?: PresetStoreStatus }>;
  disconnectPresetStore: () => Promise<{ success: boolean; message: string }>;
  createPresetStore: (
    name: string,
    writePolicy: WritePolicy
  ) => Promise<{ success: boolean; message: string; status?: PresetStoreStatus }>;
  setPresetStorePolicy: (
    policy: WritePolicy
  ) => Promise<{ success: boolean; message: string; status?: PresetStoreStatus }>;
  /**
   * `needsConfirmation` comes back when publishing would replace a preset somebody else
   * published — ids are derived from names, so two people can collide by accident. Call
   * again with overwrite to go ahead.
   */
  publishPreset: (
    id: string,
    overwrite?: boolean
  ) => Promise<{ success: boolean; message: string; needsConfirmation?: boolean; status?: PresetStoreStatus }>;
  unpublishPreset: (id: string) => Promise<{ success: boolean; message: string; status?: PresetStoreStatus }>;
  importPreset: (
    id: string,
    overwrite?: boolean
  ) => Promise<{ success: boolean; message: string; needsConfirmation?: boolean; preset?: Preset }>;
  /** Compares a store preset against this install without importing a copy of it. */
  getStorePresetReport: (id: string) => Promise<{ success: boolean; report?: PresetReport; message?: string }>;

  // --- addons: compatibility and companion mods (v1.2.2) ---
  getAddonSuggestions: () => Promise<{
    success: boolean;
    suggestions?: AddonSuggestion[];
    catalogueSize?: number;
    /** False = the bundled harvest, whose download links no longer resolve. */
    catalogueLive?: boolean;
    /** Everything installed as an addon, including those with no folder of their own. */
    ledger?: InstalledAddonRecord[];
    message?: string;
  }>;
  /** Drops an addon from the list. Never deletes files — see the handler for why. */
  forgetAddon: (forgeAddonId?: number, name?: string) => Promise<{ success: boolean; message: string }>;
  /** Reads the installed assemblies — on demand, not part of a scan. */
  detectAddonLinks: () => Promise<{
    success: boolean;
    links?: AddonLink[];
    integrations?: AddonIntegration[];
    message?: string;
  }>;
  setAddonParent: (
    id: string,
    type: ModType,
    parentName: string | null
  ) => Promise<{ success: boolean; message: string }>;
  /** No version argument: which build fits depends on the parent's installed version. */
  installForgeAddon: (
    jobId: string,
    addonId: number
  ) => Promise<{ success: boolean; message: string; installedAs?: string[] }>;
  installAddonFromFile: (
    parentName: string,
    filePath?: string
  ) => Promise<{ success: boolean; cancelled?: boolean; message?: string; installedAs?: string[] }>;
  installAddonFromGithub: (args: {
    jobId: string;
    parentName: string;
    assetUrl: string;
    assetName: string;
    repo: string;
    version: string;
  }) => Promise<{ success: boolean; message: string; installedAs?: string[] }>;

  // --- preset payloads (phase 3): the store carries the mod files ---
  publishPresetWithPayloads: (
    id: string,
    overwrite?: boolean
  ) => Promise<{
    success: boolean;
    message: string;
    needsConfirmation?: boolean;
    stored?: number;
    reused?: number;
    failed?: { name: string; message: string }[];
    status?: PresetStoreStatus;
  }>;
  installPresetPayloads: (
    id: string,
    names?: string[]
  ) => Promise<{
    success: boolean;
    message: string;
    installed?: string[];
    failed?: { name: string; message: string }[];
    /** Named by the preset but not carried by it — a different problem from a failure. */
    skipped?: { name: string; message: string }[];
  }>;
  verifyPresetPayloads: (
    id: string,
    deep?: boolean
  ) => Promise<{ success: boolean; message: string; results?: PayloadVerifyRow[] }>;
  cancelPresetPayloads: () => Promise<{ success: boolean; message: string }>;
  getStoreUsage: () => Promise<{ success: boolean; usage?: StoreUsage; human?: string; message?: string }>;
  cleanStorePayloads: () => Promise<{ success: boolean; message: string; removed?: string[]; bytesFreed?: number }>;
  onPresetPayloadProgress: (callback: (p: PayloadProgress) => void) => () => void;

  // --- preset files: sharing with no store at all ---
  exportPresetFile: (
    id: string
  ) => Promise<{ success: boolean; cancelled?: boolean; message?: string; path?: string }>;
  importPresetFile: (
    overwrite?: boolean,
    knownPath?: string
  ) => Promise<{
    success: boolean;
    cancelled?: boolean;
    message?: string;
    needsConfirmation?: boolean;
    preset?: Preset;
    /** Echoed back so confirming an overwrite reuses the file already chosen. */
    path?: string;
  }>;

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
  resolveModRef: (input: string) => Promise<{ success: boolean; modId?: number; message?: string }>;
  /** Folder name -> catalogue mod id, from the match cache (confirmed identities only). */
  getInstalledCatalogueIds: () => Promise<Record<string, string>>;
  checkModDependencies: (
    modId: number,
    version: string
  ) => Promise<{ success: boolean; check?: DependencyCheck; message?: string }>;
  checkBundles: () => Promise<{
    success: boolean;
    summary?: string;
    cacheDir?: string;
    serverBundleCount?: number;
    ok?: number;
    missing?: { fileName: string; modPath: string }[];
    stale?: { fileName: string; modPath: string }[];
    orphans?: number;
    orphanBytes?: number;
    message?: string;
  }>;
  syncBundles: () => Promise<{
    success: boolean;
    downloaded?: number;
    failed?: number;
    cancelled?: boolean;
    failures?: { fileName: string; message?: string }[];
    message?: string;
  }>;
  cancelBundleSync: () => Promise<{ success: boolean }>;
  onBundleProgress: (
    callback: (data: {
      phase: "verify" | "download";
      done: number;
      total: number;
      bytes?: number;
      current?: string;
    }) => void
  ) => () => void;
  checkAllDependencies: () => Promise<{
    success: boolean;
    rows?: { mod: string; reports: DependencyReport[] }[];
    checked?: number;
    answered?: number;
    unknown?: number;
    message?: string;
    error?: string;
  }>;
  getRegistrySource: () => Promise<{ apiBase: string; siteBase: string; host: string; isDefault: boolean }>;
  setRegistrySource: (value: string | null) => Promise<{ success: boolean; message?: string }>;
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
  /** Pass the guid when there is one: a folder name is not the published name. */
  findForgeDownloadForName: (
    name: string,
    sptVersion?: string,
    guid?: string
  ) => Promise<{ found: boolean; downloadLink?: string; version?: string; forgeName?: string; guessed?: boolean }>;
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