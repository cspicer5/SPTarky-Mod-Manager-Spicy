export type ModType = "server" | "client" | "hybrid" | "unknown";

export interface ModInfo {
  id: string; // folder/file name, used as the unique identifier
  name: string; // display name (the alias if one is set, otherwise the original name)
  originalName: string; // name derived from the folder/file; never changes
  type: ModType;
  enabled: boolean;
  installedManually: boolean; // true if absent from our registry (dropped into the folder by hand)
  loadOrder: number; // position in the load order (only meaningful for server mods)
  version?: string; // read from the mod's package.json, when present
  /**
   * Where `version` came from.
   *
   *   "recorded" - what the app actually installed, with the files unchanged since. The
   *                STRONGEST source, and it outranks the mod's own declaration: a mod that
   *                does not maintain its version string cannot contradict the release we
   *                downloaded.
   *   "declared" - the mod's own metadata. Absent for brevity when nothing else applies.
   *   "sibling"  - taken from another part of the same package
   *   "assembly" - the compiled assembly's own version; weakest, may be stale
   *   "stale-record" - a version WAS recorded at install, but the files have changed since,
   *                so the record can no longer be trusted and the declaration is shown.
   */
  versionSource?: "recorded" | "sibling" | "assembly" | "stale-record";
  /** For a recorded version: where it came from and the evidence, for display. */
  versionOrigin?: VersionOrigin;
  versionEvidence?: string;
  /** Set when the recorded and declared versions disagree — the interesting case. */
  declaredVersion?: string;
  /**
   * Where this mod's code lives. The route to checking for updates once Forge is gone:
   * GitHub's releases API needs no authentication, but only if the repository is known.
   * Derived from the Forge match cache plus the pre-shutdown harvest, not stored.
   */
  sourceUrl?: string;
  /** "owner/repo" when the source is GitHub — what the releases API takes. */
  sourceRepo?: string;
  /* --- addon relationship, projected from the registry (v1.2.2) ---------- */
  /** The mod this one attaches to. Its presence is what makes a row an addon. */
  addonOf?: string;
  addonOfType?: ModType;
  forgeAddonId?: number;
  /** The range of PARENT versions this build declares it fits, e.g. "~2.7.0". */
  addonParentConstraint?: string;
  /**
   * The mod's licence, when anything knows it — which today is almost never. The Forge API
   * has no licence field at all (checked 2026-08-06), so the pre-shutdown harvest could not
   * capture one; a live SPT server reports it, but only for the server mods it has loaded.
   * Carried so that publishing a preset can show what is being redistributed.
   */
  license?: string;
  assemblyVersion?: string; // the assembly's own version, kept for the fallback above
  author?: string; // read from the mod's package.json, when present
  installedAt?: string; // ISO date of when the app installed it (local registry)
  // true = "orphan" mod tracked by manifest (no folder of its own); cannot be
  // enabled/disabled. NOTE: this comment previously ended up merged onto `guid` below.
  manifestOnly?: boolean;
  guid?: string; // GUID declared by the mod (SPT 4.0) — exact match against Forge
  /**
   * The GUID read from the ASSEMBLY itself — `[BepInPlugin]` on a client plugin,
   * `AbstractModMetadata` on a server mod.
   *
   * Kept separate from `guid` above, which prefers the registry's forgeGuid and is therefore a
   * MIXED namespace: forgeGuid identifies the catalogue PACKAGE and is many-to-one against
   * folders (HollywoodFX 2.0.0 installs both `HollywoodFX` and `HollywoodGraphics`, and the
   * registry gives both `com.janky.hollywoodfx`), while this one identifies a single assembly
   * and the two are often not even the same string — `Tyfon.UIFixes.dll` declares
   * `Tyfon.UIFixes` where the catalogue says `com.tyfon.uifixes`.
   *
   * This is the field to compare against a remote machine's plugins, because the companion
   * reads the same attribute over there. Comparing against `guid` instead matches a mod to its
   * packaging sibling — and does it silently, since the sibling usually carries the same version.
   */
  assemblyGuid?: string;
  /**
   * The catalogue's identifier for the PACKAGE this was installed from, straight out of the
   * registry's forgeGuid — unmixed, unlike `guid`.
   *
   * Many-to-one against folders by nature, so it can never key a row on its own. What it CAN do
   * is corroborate a weaker match: when two machines' install records name the same package for
   * the same folder, a name match is no longer a guess. `Tyfon.UIFixes.Net.dll` declares no
   * `[BepInPlugin]` at all, so it can only ever be matched by name — but both ledgers say
   * `com.tyfon.uifixes`, which is real evidence and should not be presented as doubt.
   */
  catalogueGuid?: string;
  linkedModName?: string; // display name of a "linked" mod (e.g. a loose file from the same install) — removing one removes the other
  sptVersion?: string;
  sptCompatibility?: "compatible" | "incompatible" | "unknown"; // SPT version declared by the mod vs. this instance
  packageId?: string; // parts installed from the same archive share this id
  // true = this mod joined its package by folder-name similarity rather than by an install
  // record, so the grouping is a reasonable guess rather than evidence
  packageInferred?: boolean;
  packageSiblings?: { id: string; type: ModType }[];
}

/**
 * Which install an operation applies to.
 *
 * "main" is the ordinary SPT instance: a client (BepInEx/) and a server (user/mods/).
 * "headless" is a Fika headless client, which has a client side ONLY — it shares the main
 * instance's server. Every path-taking IPC handler carries this, because both instances are
 * visible on screen at once and either can be acted on.
 */
export type InstanceId = "main" | "headless";

export interface InstanceConfig {
  sptPath: string | null;
  serverRoot: string | null; // usually the same as sptPath; differs only in "split" installs (client in one folder, server in a subfolder)
  // Root of the Fika headless client, when one is configured. There is no serverRoot to go
  // with it: a headless client loads nothing from user/mods, so it has no server side to
  // point at. Null means the dual-instance view is simply not shown.
  headlessPath: string | null;
  // Manual headless classifications, keyed by normalised mod name. The user's judgement
  // outranks every rule, exactly as a manual Forge pin outranks every matching strategy.
  headlessOverrides: Record<string, string> | null;
  // Address of a live SPT server to compare against, e.g. "192.168.1.78:6969". Deliberately
  // NOT an InstanceId: a server is remote and read-only, so it can never be the target of a
  // toggle, an install or a removal. Keeping it out of that union means the type system
  // refuses to let it become one by accident.
  serverUrl: string | null;
  sptVersionOverride: string | null;
  forgeStatusCache: { name: string; status: "update" | "blocked" | "incompatible" | "info"; version?: string }[] | null;
  forgeCheckedAt: string | null;
  // Folder holding the shared preset store — a Windows share, a VPN-reachable path, or a
  // sync folder. Like serverUrl this is deliberately not an InstanceId: a store holds
  // manifests, not an install, and can never be scanned or toggled.
  // Addon-to-parent links the user set by hand, keyed "<type>:<lowercased folder>". Their
  // judgement outranks anything derived, exactly as a manual Forge pin does.
  addonLinks: Record<string, string> | null;
  // Overrides where the mod catalogue is read from. Null = the address built into this
  // release. Stored rather than compiled in because the catalogue moved once already (Forge
  // -> its successor), and a further move would otherwise strand every existing install.
  registryApiBase: string | null;
  presetStorePath: string | null;
  // The name this client publishes under. Presets are shared between people, so "who wrote
  // this" has to be a name a human chose, not a machine account or a folder path.
  presetIdentity: string | null;
}

/**
 * Where a recorded version came from. Ordered strongest to weakest.
 *
 * "forge" and "github" are statements by the place the file was downloaded FROM, which is
 * the only party that reliably knows which release it handed over. "archive-name" is read
 * off the filename. "declared-at-install" is what the mod itself claimed at the moment it
 * went in — kept because it at least pins a point in time.
 */
/**
 * `server` is the strongest of these: the files came byte-for-byte from the machine being
 * matched, and the version recorded is the one that machine reported for them. There is no
 * catalogue lookup in between to pick a different build.
 */
export type VersionOrigin = "forge" | "github" | "archive-name" | "declared-at-install" | "preset" | "server";

/**
 * A cheap signature of a mod's files on disk, taken at install time.
 *
 * Its only job is to answer "have these files changed since we put them there?", so that a
 * recorded version is not reported with confidence after someone has dropped a newer build
 * over the top by hand. Deliberately NOT a content hash: the largest mods here are ~4.7 GB
 * (Unity asset bundles), and hashing those on every scan would make scanning unusable. A
 * stat-only walk catches replaced, added and removed files, which is the realistic case.
 */
export interface ModFingerprint {
  files: number;
  bytes: number;
  newestMtime: string;
}

export interface RegistryEntry {
  id: string;
  displayName: string;
  type: ModType;
  installedAt: string;
  source: "archive-install" | "manual";
  /**
   * The version the app actually installed, as opposed to whatever the mod says about
   * itself. These disagree often enough to matter: Fika's server mod declares 2.0.9 no
   * matter which build you have, so an install of 2.3.5 reports as 2.0.9 forever.
   */
  installedVersion?: string;
  versionOrigin?: VersionOrigin;
  /** What the origin was, in words — an archive filename, a release tag, a Forge mod id. */
  versionEvidence?: string;
  /** Files as they were immediately after installation. See ModFingerprint. */
  fingerprint?: ModFingerprint;
  linkedModId?: string;
  linkedModIds?: string[]; // on the orphan's registry entry: every mod that came from the same archive
  // Data Forge gave us at install time — a trustworthy source, used when the mod does
  // not expose these fields locally (e.g. a client mod, which has no author field).
  forgeName?: string;
  forgeAuthor?: string;
  forgeVersion?: string;
  forgeGuid?: string; // id of another registry entry "linked" to this one (e.g. a named mod plus the loose file that shipped with it) — removing one removes the other
  packageId?: string;

  /* --- addons: a mod whose reason to exist is another mod (v1.2.2) -------- */
  /**
   * The folder name of the mod this one attaches to. Set when installed as an addon, or
   * pinned by hand. Its presence is what makes a row an addon rather than a mod.
   */
  addonOf?: string;
  addonOfType?: ModType;
  /** Forge's addon id, so a catalogued addon stays identifiable after the shutdown. */
  forgeAddonId?: number;
  /** The range of PARENT versions the installed build declares it fits, e.g. "~2.7.0". */
  addonParentConstraint?: string;
}

export interface InstallResult {
  success: boolean;
  message: string;
  mod?: ModInfo;
}

export interface ModListComparison {
  missing: string[]; // present in the imported list, but not found in the current instance
  extra: string[]; // present in the current instance, but absent from the imported list
}