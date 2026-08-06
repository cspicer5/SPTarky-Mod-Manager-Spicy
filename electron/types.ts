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
   * Where `version` came from, when it was not declared by the mod itself. Absent means
   * the mod declared it directly, which is the only fully trustworthy case.
   *   "sibling"  - taken from another part of the same package
   *   "assembly" - the compiled assembly's own version; weakest, may be stale
   */
  versionSource?: "sibling" | "assembly";
  assemblyVersion?: string; // the assembly's own version, kept for the fallback above
  author?: string; // read from the mod's package.json, when present
  installedAt?: string; // ISO date of when the app installed it (local registry)
  // true = "orphan" mod tracked by manifest (no folder of its own); cannot be
  // enabled/disabled. NOTE: this comment previously ended up merged onto `guid` below.
  manifestOnly?: boolean;
  guid?: string; // GUID declared by the mod (SPT 4.0) — exact match against Forge
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
  sptVersionOverride: string | null;
  forgeStatusCache: { name: string; status: "update" | "blocked" | "incompatible" | "info"; version?: string }[] | null;
  forgeCheckedAt: string | null;
}

export interface RegistryEntry {
  id: string;
  displayName: string;
  type: ModType;
  installedAt: string;
  source: "archive-install" | "manual";
  linkedModId?: string;
  linkedModIds?: string[]; // on the orphan's registry entry: every mod that came from the same archive
  // Data Forge gave us at install time — a trustworthy source, used when the mod does
  // not expose these fields locally (e.g. a client mod, which has no author field).
  forgeName?: string;
  forgeAuthor?: string;
  forgeVersion?: string;
  forgeGuid?: string; // id of another registry entry "linked" to this one (e.g. a named mod plus the loose file that shipped with it) — removing one removes the other
  packageId?: string;
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