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

export interface InstanceConfig {
  sptPath: string | null;
  serverRoot: string | null; // usually the same as sptPath; differs only in "split" installs (client in one folder, server in a subfolder)
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