/**
 * Mod presets — phase 1: local only.
 *
 * A preset is a named snapshot of a working setup: which mods, at which versions, enabled or
 * not, in what load order. See docs/PRESETS.md for the full design, including the shared
 * store and payloads that phases 2 and 3 add.
 *
 * The important idea is that **a preset is a virtual instance**. Applying one is the same
 * reconciliation the app already does against a live server or a headless client, with a
 * static snapshot on the other side. So this module owns the data model and the storage, and
 * borrows the comparison logic's shape rather than inventing a second one.
 *
 * Presets live in the app's own data directory, NOT in an instance. A preset's whole purpose
 * is to be applied to a different install from the one it came from; storing it inside an
 * instance would tie it to the thing it is meant to be independent of.
 */
import fs from "fs";
import path from "path";
import { ModInfo, ModType } from "./types";
import { compareVersions } from "./modManager";

export const PRESET_SCHEMA = 1;

export interface PresetMod {
  /** Folder name — the identity used on disk, and the fallback match key. */
  name: string;
  guid?: string;
  version?: string;
  /**
   * How solid `version` is, carried from the scan. A preset built from mods the app itself
   * installed has real versions; one built from hand-dropped mods inherits whatever they
   * declare, which may be wrong. Recording this stops a preset asserting more than it knows.
   */
  versionSource?: ModInfo["versionSource"];
  type: ModType;
  enabled: boolean;
  loadOrder: number;
  /** false = "part of my setup, but you can play without it". */
  required: boolean;
  author?: string;

  /* --- phase 3: set only when the preset carries the mod's files --------- */
  /** Key into the store's `mods/` directory. Its absence means "named, not carried". */
  payload?: string;
  /** Content hash of the payload, so a preset resolves to the exact bytes it was built from. */
  payloadHash?: string;
  sizeBytes?: number;
  /**
   * Recorded because someone publishing a bundle of other people's work should be able to
   * see what they are sharing. Several installed mods are CC-BY-NC-ND and one is PUSL.
   */
  license?: string;
  sourceUrl?: string;

  /* --- addons (v1.2.2) --------------------------------------------------- */
  /**
   * The mod this one attaches to, captured so applying a preset rebuilds the RELATIONSHIP
   * and not only the files. A preset that reproduces an install without knowing which mods
   * were addons produces a setup that looks identical and has forgotten what belongs to what
   * — and the app then cannot tell the recipient that updating a parent has stranded one.
   */
  addonOf?: string;
  addonOfType?: ModType;
  forgeAddonId?: number;
  addonParentConstraint?: string;
}

export interface Preset {
  schema: number;
  id: string;
  name: string;
  description?: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  /** The SPT version this was captured against. Applying it elsewhere warns. */
  sptVersion?: string;
  /** Phase 3 sets this true when the preset carries the mod files. */
  hasPayloads: boolean;
  /**
   * Where this came from, when it was imported from a shared store rather than captured
   * here. Applying a preset copies somebody else's idea of a correct setup onto your
   * machine, so the source stays visible afterwards rather than only at the moment you
   * clicked import.
   */
  origin?: {
    store: string;
    path: string;
    author?: string;
    importedAt: string;
  };
  mods: PresetMod[];
}

/* --------------------------------------------------------------------------
 * Storage
 * ----------------------------------------------------------------------- */

function presetsDir(root: string): string {
  return path.join(root, "presets");
}

function presetPath(root: string, id: string): string {
  return path.join(presetsDir(root), `${id}.json`);
}

/** Filesystem-safe, readable, and stable enough to be a filename. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "preset";
}

function uniqueId(root: string, desired: string): string {
  let id = desired;
  let n = 2;
  while (fs.existsSync(presetPath(root, id))) id = `${desired}-${n++}`;
  return id;
}

export function listPresets(root: string): Preset[] {
  const dir = presetsDir(root);
  if (!fs.existsSync(dir)) return [];
  const out: Preset[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as Preset;
      // A file that is not a preset, or is from a newer schema, is skipped rather than
      // crashing the list — one bad file must not hide every good one.
      if (parsed?.schema === PRESET_SCHEMA && Array.isArray(parsed.mods)) out.push(parsed);
    } catch {
      /* unreadable — skip */
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function readPreset(root: string, id: string): Preset | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(presetPath(root, id), "utf-8")) as Preset;
    return parsed?.schema === PRESET_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Written via a temp file and renamed, so an interrupted write cannot leave a half-preset.
 *
 * Exported as `savePreset` for the store, which needs to write a preset it did not capture
 * (an import) without going through `createPreset` and minting a new identity for it.
 */
export function savePreset(root: string, preset: Preset): void {
  writePreset(root, preset);
}

function writePreset(root: string, preset: Preset): void {
  const dir = presetsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = presetPath(root, preset.id);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(preset, null, 2), "utf-8");
  fs.renameSync(temp, target);
}

export function deletePreset(root: string, id: string): { success: boolean; message: string } {
  const target = presetPath(root, id);
  if (!fs.existsSync(target)) return { success: false, message: "That preset no longer exists." };
  fs.rmSync(target, { force: true });
  return { success: true, message: "Preset deleted." };
}

/* --------------------------------------------------------------------------
 * Capture
 * ----------------------------------------------------------------------- */

export interface CreatePresetOptions {
  name: string;
  description?: string;
  author?: string;
  sptVersion?: string;
  /** Folder names to include. Omitted means everything that was scanned. */
  include?: string[];
  /** Folder names that are merely nice to have. Everything else is required. */
  optional?: string[];
}

export function createPreset(root: string, mods: ModInfo[], opts: CreatePresetOptions): Preset {
  const include = opts.include ? new Set(opts.include) : null;
  const optional = new Set(opts.optional ?? []);
  const now = new Date().toISOString();

  const preset: Preset = {
    schema: PRESET_SCHEMA,
    id: uniqueId(root, slugify(opts.name)),
    name: opts.name.trim() || "Untitled preset",
    description: opts.description?.trim() || undefined,
    author: opts.author?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    sptVersion: opts.sptVersion,
    hasPayloads: false,
    mods: mods
      .filter((m) => !m.manifestOnly && (!include || include.has(m.id)))
      .map((m) => ({
        name: m.id,
        guid: m.guid,
        version: m.version,
        versionSource: m.versionSource,
        type: m.type,
        enabled: m.enabled,
        loadOrder: m.loadOrder,
        required: !optional.has(m.id),
        author: m.author,
        addonOf: m.addonOf,
        addonOfType: m.addonOfType,
        forgeAddonId: m.forgeAddonId,
        addonParentConstraint: m.addonParentConstraint
      }))
  };

  writePreset(root, preset);
  return preset;
}

/** Re-captures an existing preset from the current install, keeping its identity. */
export function updatePreset(root: string, id: string, mods: ModInfo[], sptVersion?: string): Preset | null {
  const existing = readPreset(root, id);
  if (!existing) return null;
  // Optional flags are a human judgement that a rescan knows nothing about, so they are
  // carried across rather than silently reset to "everything is required".
  const optional = existing.mods.filter((m) => !m.required).map((m) => m.name);
  const rebuilt = createPreset(root, mods, {
    name: existing.name,
    description: existing.description,
    author: existing.author,
    sptVersion,
    optional
  });
  // createPreset minted a new id; move the content onto the original and drop the duplicate.
  fs.rmSync(presetPath(root, rebuilt.id), { force: true });
  const merged: Preset = { ...rebuilt, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
  writePreset(root, merged);
  return merged;
}

export function renamePreset(root: string, id: string, name: string, description?: string): Preset | null {
  const existing = readPreset(root, id);
  if (!existing) return null;
  const updated: Preset = {
    ...existing,
    name: name.trim() || existing.name,
    description: description?.trim() || undefined,
    updatedAt: new Date().toISOString()
  };
  writePreset(root, updated);
  return updated;
}

/* --------------------------------------------------------------------------
 * Reconciliation
 * ----------------------------------------------------------------------- */

export type PresetIssue =
  | "missing"
  | "version-mismatch"
  | "state-mismatch"
  | "extra"
  | "unknown-version"
  /**
   * An addon in this preset whose parent the preset does not include. Its own row would
   * otherwise look perfectly fine, because the addon installs and the files are all present
   * — the setup is simply incoherent, and only the relationship shows it.
   */
  | "orphaned-addon";

export interface PresetRow {
  /** Type-scoped, so a mod shipping a server and a client half stays two rows. */
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
  /** Set when this row is an addon, so the UI can show it under what it attaches to. */
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
  /** True when everything the preset requires is present, at the right version and state. */
  satisfied: boolean;
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/\.dll$/, "");
const sideOf = (t: ModType) => (t === "server" ? "server" : "client");
const rowKey = (name: string, type: ModType) => `${sideOf(type)}:${norm(name)}`;

/**
 * Compares a preset against an install.
 *
 * Matching is GUID first, then name, and always scoped by side. Both halves matter here in a
 * way they do not for a remote server (which can only report its server mods), so a mod that
 * ships a server half and a client half under one folder name must stay two rows — the same
 * collision that produced wrong verdicts in the headless parity report.
 */
export function buildPresetReport(preset: Preset, localMods: ModInfo[], localSptVersion?: string): PresetReport {
  const counts = {
    matching: 0,
    missing: 0,
    missingRequired: 0,
    versionMismatch: 0,
    stateMismatch: 0,
    extra: 0,
    unknownVersion: 0,
    orphanedAddon: 0
  };

  // Which mods the preset actually contains, so an addon pointing outside it can be spotted.
  const presetContains = new Set(preset.mods.map((m) => rowKey(m.name, m.type)));
  const addonsByParent: Record<string, string[]> = {};
  for (const m of preset.mods) {
    if (!m.addonOf) continue;
    (addonsByParent[m.addonOf] ??= []).push(m.name);
  }

  const byGuid = new Map<string, ModInfo>();
  const byKey = new Map<string, ModInfo>();
  for (const mod of localMods) {
    if (mod.manifestOnly) continue;
    if (mod.guid) byGuid.set(`${sideOf(mod.type)}:${norm(mod.guid)}`, mod);
    byKey.set(rowKey(mod.id, mod.type), mod);
  }

  const rows: PresetRow[] = [];
  const claimed = new Set<string>();

  for (const want of preset.mods) {
    const viaGuid = want.guid ? byGuid.get(`${sideOf(want.type)}:${norm(want.guid)}`) : undefined;
    const local = viaGuid ?? byKey.get(rowKey(want.name, want.type));
    if (local) claimed.add(rowKey(local.id, local.type));

    const row: PresetRow = {
      key: rowKey(want.name, want.type),
      name: want.name,
      type: want.type,
      guid: want.guid,
      presetVersion: want.version,
      localVersion: local?.version,
      presetEnabled: want.enabled,
      localEnabled: local?.enabled,
      required: want.required,
      matchedBy: viaGuid ? "guid" : local ? "name" : undefined,
      addonOf: want.addonOf
    };

    // Checked before the presence tests, because an addon whose parent is absent from the
    // preset is wrong even when the addon itself installs perfectly. Nothing about its own
    // row would ever reveal that.
    if (want.addonOf && !presetContains.has(rowKey(want.addonOf, want.addonOfType ?? "server"))
        && !presetContains.has(rowKey(want.addonOf, "client"))
        && !presetContains.has(rowKey(want.addonOf, "server"))) {
      row.issue = "orphaned-addon";
      row.detail = `Attaches to "${want.addonOf}", which this preset does not include.`;
      counts.orphanedAddon++;
      rows.push(row);
      continue;
    }

    if (!local) {
      row.issue = "missing";
      row.detail = want.required ? "Required by this preset and not installed." : "Part of this preset, not installed.";
      counts.missing++;
      if (want.required) counts.missingRequired++;
    } else if (want.version && local.version && compareVersions(want.version, local.version) !== 0) {
      row.issue = "version-mismatch";
      row.detail = `The preset expects ${want.version}; this install has ${local.version}.`;
      counts.versionMismatch++;
    } else if (!want.version || !local.version) {
      // Present on both sides, but at least one has no usable version. Saying "matching"
      // would claim more than is known — some mods simply do not declare one.
      row.issue = "unknown-version";
      row.detail = "Installed, but there is no version on one side to compare.";
      counts.unknownVersion++;
    } else if (want.enabled !== local.enabled) {
      row.issue = "state-mismatch";
      row.detail = want.enabled ? "The preset has this enabled; it is disabled here." : "The preset has this disabled; it is enabled here.";
      counts.stateMismatch++;
    } else {
      counts.matching++;
    }
    rows.push(row);
  }

  for (const mod of localMods) {
    if (mod.manifestOnly) continue;
    const key = rowKey(mod.id, mod.type);
    if (claimed.has(key)) continue;
    rows.push({
      key,
      name: mod.id,
      type: mod.type,
      guid: mod.guid,
      localVersion: mod.version,
      localEnabled: mod.enabled,
      required: false,
      issue: "extra",
      detail: "Installed here but not part of this preset."
    });
    counts.extra++;
  }

  const sptMatches =
    preset.sptVersion && localSptVersion ? compareVersions(preset.sptVersion, localSptVersion) === 0 : undefined;

  const severity: Record<string, number> = {
    missing: 0,
    "version-mismatch": 1,
    "orphaned-addon": 2,
    "state-mismatch": 3,
    "unknown-version": 4,
    extra: 5
  };
  rows.sort((a, b) => {
    // Required-but-missing is the only thing that actually stops you playing, so it leads.
    const ra = a.issue === "missing" && a.required ? -1 : 0;
    const rb = b.issue === "missing" && b.required ? -1 : 0;
    if (ra !== rb) return ra - rb;
    const sa = a.issue ? severity[a.issue] ?? 9 : 9;
    const sb = b.issue ? severity[b.issue] ?? 9 : 9;
    return sa !== sb ? sa - sb : a.name.localeCompare(b.name);
  });

  return {
    presetId: preset.id,
    presetName: preset.name,
    sptVersion: preset.sptVersion,
    localSptVersion,
    sptMatches,
    rows,
    counts,
    addonsByParent: Object.keys(addonsByParent).length ? addonsByParent : undefined,
    // "Extra" mods and optional gaps do not stop you playing; a missing required mod, a
    // version mismatch, or a mod that should be on and is off, do.
    satisfied:
      counts.missingRequired === 0 && counts.versionMismatch === 0 && counts.stateMismatch === 0 && sptMatches !== false
  };
}
