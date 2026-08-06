/**
 * Mod presets — phase 2: the shared folder store.
 *
 * A store is just a folder. It may be a Windows share (`\\host\SPT-Presets`), a
 * VPN-reachable path, a Syncthing folder, or a plain local directory. The app only ever does
 * file I/O, so distribution and access control belong to the share — which is precisely why
 * the same code works on LAN, over a VPN, or through a sync tool without knowing which.
 *
 *   <store>/
 *     store.json          name, schema, write policy, owner
 *     presets/
 *       stable-coop.json  one file per preset
 *     mods/               phase 3 — payloads, not written here
 *
 * Two decisions carry most of the weight:
 *
 * **One file per preset, never a shared index.** The list is rebuilt by reading the folder.
 * Two people publishing at once cannot corrupt an index that does not exist, and a sync tool
 * that resolves conflicts by duplicating files can only ever produce an extra file — which
 * is detected and reported rather than silently believed.
 *
 * **Everything here is async.** Phase 1 used sync fs because presets lived in the app's own
 * data directory, where a read cannot fail slowly. A store can be an unreachable network
 * path, and a sync read against one blocks the main process — freezing the entire UI, not
 * just the panel. The threadpool absorbs that instead.
 */
import fsp from "fs/promises";
import fs from "fs";
import path from "path";
import { Preset, PresetMod, PRESET_SCHEMA, savePreset, readPreset } from "./presets";
import { ModInfo } from "./types";
import {
  collectModPayloadFiles,
  storePayload,
  applyPayload,
  formatBytes,
  PayloadProgress
} from "./presetPayloads";
import { recordPayloadInstall } from "./modManager";
import { markInstalledAsAddon } from "./addons";

export const STORE_SCHEMA = 1;

/**
 * Who may publish.
 *
 * This is a CONVENTION, not a security control: it lives in a file that anyone with write
 * access to the folder can edit. Real enforcement is the share's own permissions, which is
 * the right place for it. The app says so out loud rather than implying a guarantee it
 * cannot make.
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
  /** File name within presets/, so a conflicted copy can be named exactly. */
  file: string;
  /**
   * Set when several files in the store claimed the same preset id — the shape a sync tool
   * leaves behind when two people edit at once ("foo.sync-conflict-….json"). The newest wins
   * for display, but the collision is surfaced rather than hidden.
   */
  conflictsWith?: string[];
}

export interface StoreStatus {
  path: string;
  connected: boolean;
  info?: PresetStoreInfo;
  entries: StoreEntry[];
  /** Whether this identity may publish, and why not when it may not. */
  canPublish: boolean;
  publishBlockedReason?: string;
  message?: string;
}

/* --------------------------------------------------------------------------
 * Layout
 * ----------------------------------------------------------------------- */

const storeInfoPath = (dir: string) => path.join(dir, "store.json");
const storePresetsDir = (dir: string) => path.join(dir, "presets");
const storePresetPath = (dir: string, id: string) => path.join(storePresetsDir(dir), `${id}.json`);

/** Written to a temp name and renamed, so a half-written file is never visible to a reader. */
async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // The temp name is per-process: two clients publishing at the same moment must not collide
  // on the temp file itself, which would turn a safe write into a corrupt one.
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), "utf-8");
  await fsp.rename(temp, target);
}

function isWritePolicy(v: unknown): v is WritePolicy {
  return v === "curated" || v === "shared";
}

/* --------------------------------------------------------------------------
 * The store itself
 * ----------------------------------------------------------------------- */

/**
 * Reads and validates store.json.
 *
 * Returns null for "this folder is not a store", which is a normal answer the caller acts
 * on (by offering to create one), not an error.
 */
export async function readStoreInfo(dir: string): Promise<PresetStoreInfo | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(storeInfoPath(dir), "utf-8"));
    if (raw?.schema !== STORE_SCHEMA) return null;
    if (typeof raw.name !== "string" || !raw.name.trim()) return null;
    // An unrecognised policy is treated as the STRICTER one. A store written by a future
    // version might use a policy this build has never heard of; guessing "shared" would let
    // this client publish into a store that meant to forbid it.
    const writePolicy: WritePolicy = isWritePolicy(raw.writePolicy) ? raw.writePolicy : "curated";
    return {
      schema: STORE_SCHEMA,
      name: String(raw.name),
      writePolicy,
      owner: typeof raw.owner === "string" ? raw.owner : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

export interface InitStoreOptions {
  name: string;
  owner: string;
  writePolicy?: WritePolicy;
}

/**
 * Creates a store in `dir`.
 *
 * Refuses to overwrite an existing store: pointing "create" at a folder that already holds
 * everyone's presets would reassign ownership of the whole thing to whoever clicked it.
 */
export async function initStore(
  dir: string,
  opts: InitStoreOptions
): Promise<{ success: boolean; message: string; info?: PresetStoreInfo }> {
  if (!opts?.name?.trim()) return { success: false, message: "The store needs a name." };
  const existing = await readStoreInfo(dir);
  if (existing) {
    return {
      success: false,
      message: `That folder is already the store "${existing.name}". Connect to it instead of creating one.`
    };
  }
  const info: PresetStoreInfo = {
    schema: STORE_SCHEMA,
    name: opts.name.trim(),
    writePolicy: opts.writePolicy ?? "shared",
    owner: opts.owner?.trim() || "",
    createdAt: new Date().toISOString()
  };
  try {
    await fsp.mkdir(storePresetsDir(dir), { recursive: true });
    await writeJsonAtomic(storeInfoPath(dir), info);
    return { success: true, message: `Created the preset store "${info.name}".`, info };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't create a store there." };
  }
}

/** Changes the write policy. Only the owner may, under either policy. */
export async function setWritePolicy(
  dir: string,
  identity: string,
  policy: WritePolicy
): Promise<{ success: boolean; message: string; info?: PresetStoreInfo }> {
  const info = await readStoreInfo(dir);
  if (!info) return { success: false, message: "That folder is not a preset store." };
  if (!sameIdentity(info.owner, identity)) {
    return { success: false, message: `Only ${info.owner || "the owner"} can change who may publish.` };
  }
  const updated: PresetStoreInfo = { ...info, writePolicy: policy };
  try {
    await writeJsonAtomic(storeInfoPath(dir), updated);
    return {
      success: true,
      info: updated,
      message: policy === "shared" ? "Anyone with access can now publish." : "Only you can publish now."
    };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't update the store." };
  }
}

/* --------------------------------------------------------------------------
 * Identity and permission
 * ----------------------------------------------------------------------- */

const sameIdentity = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether `identity` may publish into this store.
 *
 * A store with no owner recorded is treated as shared — it was created by an older or
 * hand-written store.json, and locking everyone out of their own folder would be worse than
 * the convention being loose.
 */
export function publishPermission(
  info: PresetStoreInfo,
  identity: string | undefined
): { allowed: boolean; reason?: string } {
  if (!identity?.trim()) {
    return { allowed: false, reason: "Set a publishing name first, so presets say who they came from." };
  }
  if (info.writePolicy === "shared") return { allowed: true };
  if (!info.owner) return { allowed: true };
  if (sameIdentity(info.owner, identity)) return { allowed: true };
  return { allowed: false, reason: `This store is curated — only ${info.owner} publishes to it.` };
}

/* --------------------------------------------------------------------------
 * Browsing
 * ----------------------------------------------------------------------- */

/**
 * Rebuilds the preset list by reading the folder.
 *
 * Duplicate ids are the interesting case: a sync tool that hits a conflict keeps BOTH files,
 * so the same preset can legitimately appear twice with different contents. The newest
 * updatedAt wins and the losers are named, because silently picking one is how someone ends
 * up applying a preset they did not write.
 */
export async function listStorePresets(dir: string): Promise<StoreEntry[]> {
  let files: string[];
  try {
    files = await fsp.readdir(storePresetsDir(dir));
  } catch {
    return [];
  }

  const found: { preset: Preset; file: string }[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    if (file.endsWith(".tmp")) continue;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(storePresetsDir(dir), file), "utf-8")) as Preset;
      // One unreadable or future-schema file must not hide every good one.
      if (parsed?.schema === PRESET_SCHEMA && Array.isArray(parsed.mods) && typeof parsed.id === "string") {
        found.push({ preset: parsed, file });
      }
    } catch {
      /* unreadable — skip */
    }
  }

  const byId = new Map<string, { preset: Preset; file: string }[]>();
  for (const item of found) {
    const list = byId.get(item.preset.id) ?? [];
    list.push(item);
    byId.set(item.preset.id, list);
  }

  const entries: StoreEntry[] = [];
  for (const group of byId.values()) {
    group.sort((a, b) => (b.preset.updatedAt ?? "").localeCompare(a.preset.updatedAt ?? ""));
    const [winner, ...rest] = group;
    entries.push({
      preset: winner.preset,
      file: winner.file,
      conflictsWith: rest.length ? rest.map((r) => r.file) : undefined
    });
  }

  return entries.sort((a, b) => (b.preset.updatedAt ?? "").localeCompare(a.preset.updatedAt ?? ""));
}

/** Everything the UI needs about a store in one round trip. */
export async function getStoreStatus(dir: string | null | undefined, identity?: string): Promise<StoreStatus> {
  if (!dir) return { path: "", connected: false, entries: [], canPublish: false, message: "No store connected." };

  if (!fs.existsSync(dir)) {
    return {
      path: dir,
      connected: false,
      entries: [],
      canPublish: false,
      message: "That folder can't be reached. If it's a network share, check you're connected to it."
    };
  }

  const info = await readStoreInfo(dir);
  if (!info) {
    return {
      path: dir,
      connected: false,
      entries: [],
      canPublish: false,
      message: "That folder isn't a preset store yet."
    };
  }

  const permission = publishPermission(info, identity);
  return {
    path: dir,
    connected: true,
    info,
    entries: await listStorePresets(dir),
    canPublish: permission.allowed,
    publishBlockedReason: permission.reason
  };
}

/* --------------------------------------------------------------------------
 * Publishing
 * ----------------------------------------------------------------------- */

export interface PublishResult {
  success: boolean;
  message: string;
  /** Set when the only thing standing in the way is overwriting someone else's file. */
  needsConfirmation?: boolean;
  preset?: Preset;
}

/**
 * Copies a local preset into the store.
 *
 * Publishing over a preset PUBLISHED BY SOMEONE ELSE needs explicit confirmation. Ids come
 * from the preset's name, so two people who both call a setup "Stable Co-op" collide by
 * accident rather than by intent, and the accident should not quietly destroy the other
 * person's work.
 */
export async function publishPreset(
  dir: string,
  preset: Preset,
  identity: string,
  opts: { overwrite?: boolean } = {}
): Promise<PublishResult> {
  const info = await readStoreInfo(dir);
  if (!info) return { success: false, message: "That folder is not a preset store." };

  const permission = publishPermission(info, identity);
  if (!permission.allowed) return { success: false, message: permission.reason ?? "You can't publish to this store." };

  const target = storePresetPath(dir, preset.id);
  let existing: Preset | null = null;
  try {
    const parsed = JSON.parse(await fsp.readFile(target, "utf-8")) as Preset;
    if (parsed?.schema === PRESET_SCHEMA) existing = parsed;
  } catch {
    /* nothing published under this id yet */
  }

  if (existing && !sameIdentity(existing.author, identity) && !opts.overwrite) {
    return {
      success: false,
      needsConfirmation: true,
      message: `"${existing.name}" in this store was published by ${existing.author || "someone else"}. Publishing will replace it.`
    };
  }

  const published: Preset = {
    ...preset,
    author: identity,
    updatedAt: new Date().toISOString(),
    // Phase 2 shares manifests only. Carrying the flag across would promise files that are
    // not in the store, and "apply" would then fail at the moment it mattered.
    hasPayloads: false
  };

  try {
    await writeJsonAtomic(target, published);
    return {
      success: true,
      preset: published,
      message: `Published "${published.name}" (${published.mods.length} mods) to ${info.name}.`
    };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't write to the store." };
  }
}

/** Removes a preset from the store. Its own author, or the owner, may do this. */
export async function unpublishPreset(
  dir: string,
  id: string,
  identity: string
): Promise<{ success: boolean; message: string }> {
  const info = await readStoreInfo(dir);
  if (!info) return { success: false, message: "That folder is not a preset store." };

  const entries = await listStorePresets(dir);
  const entry = entries.find((e) => e.preset.id === id);
  if (!entry) return { success: false, message: "That preset is not in this store." };

  const isAuthor = sameIdentity(entry.preset.author, identity);
  const isOwner = sameIdentity(info.owner, identity);
  if (!isAuthor && !isOwner) {
    return { success: false, message: `Only ${entry.preset.author || "its author"} or the store owner can remove that.` };
  }

  try {
    // Conflicted copies are removed too, or the preset reappears on the next read as the
    // surviving copy — looking, to everyone else, as though the removal silently failed.
    for (const file of [entry.file, ...(entry.conflictsWith ?? [])]) {
      await fsp.rm(path.join(storePresetsDir(dir), file), { force: true });
    }
    return { success: true, message: `Removed "${entry.preset.name}" from ${info.name}.` };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't remove that from the store." };
  }
}

/* --------------------------------------------------------------------------
 * Importing
 * ----------------------------------------------------------------------- */

export interface ImportResult {
  success: boolean;
  message: string;
  needsConfirmation?: boolean;
  preset?: Preset;
}

/**
 * Takes a preset that came from somewhere else and saves it locally, so every phase 1 action
 * works on it.
 *
 * Shared by both ways in — the store and a loose file — because the rules are the same
 * either way: never silently replace a preset the user already has, and always record where
 * this one came from. Applying a preset copies somebody else's idea of a correct setup onto
 * your machine; the source of that should stay visible afterwards, not only at the moment
 * you clicked import.
 */
function adoptPreset(
  localRoot: string,
  preset: Preset,
  origin: Preset["origin"],
  opts: { overwrite?: boolean },
  sourceLabel: string
): ImportResult {
  const existing = readPreset(localRoot, preset.id);
  if (existing && !opts.overwrite) {
    return {
      success: false,
      needsConfirmation: true,
      message: `You already have a preset called "${existing.name}". Importing will replace your copy.`
    };
  }
  const imported: Preset = { ...preset, origin };
  try {
    savePreset(localRoot, imported);
    return { success: true, preset: imported, message: `Imported "${imported.name}" from ${sourceLabel}.` };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't save the imported preset." };
  }
}

/** Copies a store preset into the local collection. */
export async function importPreset(
  localRoot: string,
  dir: string,
  id: string,
  opts: { overwrite?: boolean } = {}
): Promise<ImportResult> {
  const info = await readStoreInfo(dir);
  if (!info) return { success: false, message: "That folder is not a preset store." };

  const entry = (await listStorePresets(dir)).find((e) => e.preset.id === id);
  if (!entry) return { success: false, message: "That preset is not in this store." };

  return adoptPreset(
    localRoot,
    entry.preset,
    { store: info.name, path: dir, author: entry.preset.author, importedAt: new Date().toISOString() },
    opts,
    info.name
  );
}

/* --------------------------------------------------------------------------
 * Loose files — sharing without a store at all
 * ----------------------------------------------------------------------- */

/**
 * A preset manifest is ~40 KB of JSON, so the simplest possible transport is to send someone
 * the file. No share to set up, no folder to agree on, and it works over anything that
 * carries a file: Discord, email, a USB stick.
 *
 * This is deliberately the SAME format the store holds. A file a friend sends can be dropped
 * straight into a store's presets/ folder and vice versa, because there is only one format
 * and no export-only variant to drift out of step with it.
 */
export const PRESET_FILE_SUFFIX = ".sptpreset.json";

/** A filename a human can recognise in a downloads folder. */
export function presetFileName(preset: Preset): string {
  return `${preset.id}${PRESET_FILE_SUFFIX}`;
}

export async function exportPresetToFile(
  preset: Preset,
  targetPath: string
): Promise<{ success: boolean; message: string; path?: string }> {
  try {
    // Exported as-is apart from the origin, which describes where THIS machine got it and
    // means nothing to the person receiving it — keeping it would tell them the preset came
    // from a store they cannot reach.
    const { origin: _origin, ...clean } = preset;
    await writeJsonAtomic(targetPath, clean);
    return { success: true, path: targetPath, message: `Exported "${preset.name}" to ${path.basename(targetPath)}.` };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't write that file." };
  }
}

/**
 * Reads a preset file someone sent.
 *
 * Validated rather than trusted: this file arrived from outside the app, and the thing it is
 * about to become is a list of code to install. A file that is not a preset says so instead
 * of half-loading into an object with no mods.
 */
export async function importPresetFromFile(
  localRoot: string,
  filePath: string,
  opts: { overwrite?: boolean } = {}
): Promise<ImportResult> {
  let parsed: Preset;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, "utf-8")) as Preset;
  } catch (err: any) {
    return { success: false, message: `Couldn't read that file: ${err?.message ?? "unreadable"}` };
  }

  if (parsed?.schema !== PRESET_SCHEMA || !Array.isArray(parsed.mods) || typeof parsed.id !== "string" || !parsed.id) {
    return {
      success: false,
      message:
        parsed?.schema && parsed.schema > PRESET_SCHEMA
          ? "That preset was made by a newer version of the manager. Update, then try again."
          : "That file isn't a mod preset."
    };
  }

  return adoptPreset(
    localRoot,
    parsed,
    { store: "a file", path: filePath, author: parsed.author, importedAt: new Date().toISOString() },
    opts,
    path.basename(filePath)
  );
}

/** Reads one store preset without importing it, so it can be compared where it stands. */
export async function readStorePreset(dir: string, id: string): Promise<Preset | null> {
  const entry = (await listStorePresets(dir)).find((e) => e.preset.id === id);
  return entry?.preset ?? null;
}

/* --------------------------------------------------------------------------
 * Phase 3 — publishing WITH the mod files
 * ----------------------------------------------------------------------- */

export interface PublishPayloadProgress extends PayloadProgress {
  modsDone: number;
  modsTotal: number;
  /** Bytes that did not need copying because the store already had that exact content. */
  bytesReused: number;
}

export interface PublishWithPayloadsResult extends PublishResult {
  stored?: number;
  reused?: number;
  failed?: { name: string; message: string }[];
  bytesCopied?: number;
}

/**
 * Publishes a preset AND the mods it names, so applying it needs no Forge and no downloads.
 *
 * Each mod is stored under a content-addressed key and shared by every preset that uses it,
 * which is what makes this affordable: the reference install is 17.8 GB, and a second preset
 * sharing 90% of its mods costs only the remaining 10%.
 *
 * A mod whose files cannot be gathered does NOT fail the publish. It is recorded without a
 * payload — exactly what a phase 2 preset already looked like — and reported. Losing 56 good
 * payloads because the 57th had a permissions problem would be a worse answer than a preset
 * that carries most of itself.
 */
export async function publishPresetWithPayloads(
  dir: string,
  preset: Preset,
  identity: string,
  roots: { clientRoot: string; serverRoot: string },
  localMods: ModInfo[],
  onProgress?: (p: PublishPayloadProgress) => void,
  opts: { overwrite?: boolean; isCancelled?: () => boolean } = {}
): Promise<PublishWithPayloadsResult> {
  const info = await readStoreInfo(dir);
  if (!info) return { success: false, message: "That folder is not a preset store." };

  const permission = publishPermission(info, identity);
  if (!permission.allowed) return { success: false, message: permission.reason ?? "You can't publish to this store." };

  // The collision check happens BEFORE any copying. Discovering that the publish was going to
  // be refused after 17.8 GB of copying would be its own kind of insult.
  const target = await readStorePresetFile(dir, preset.id);
  if (target && !sameIdentity(target.author, identity) && !opts.overwrite) {
    return {
      success: false,
      needsConfirmation: true,
      message: `"${target.name}" in this store was published by ${target.author || "someone else"}. Publishing will replace it.`
    };
  }

  const byKey = new Map<string, ModInfo>();
  for (const mod of localMods) byKey.set(`${mod.type}:${mod.id.toLowerCase()}`, mod);

  const mods: PresetMod[] = [];
  const failed: { name: string; message: string }[] = [];
  let stored = 0;
  let reused = 0;
  let bytesCopied = 0;
  let bytesReused = 0;
  let modsDone = 0;

  for (const want of preset.mods) {
    if (opts.isCancelled?.()) {
      return { success: false, message: `Cancelled after ${modsDone} of ${preset.mods.length} mods. Nothing was published.` };
    }

    const local = byKey.get(`${want.type}:${want.name.toLowerCase()}`);
    if (!local) {
      failed.push({ name: want.name, message: "Not installed here any more." });
      mods.push({ ...want, payload: undefined, payloadHash: undefined });
      modsDone++;
      continue;
    }

    const files = collectModPayloadFiles(roots.clientRoot, roots.serverRoot, local);
    const result = await storePayload(
      dir,
      files,
      {
        name: want.name,
        version: want.version,
        type: want.type,
        guid: want.guid,
        // license is deliberately absent: the pre-shutdown harvest never captured it, and the
        // Forge API has no licence field at all, so nothing local knows it. The field stays
        // in the format so recording it later needs no migration — see docs/PRESETS.md.
        license: local.license,
        sourceUrl: local.sourceUrl
      },
      (p) => onProgress?.({ ...p, modsDone, modsTotal: preset.mods.length, bytesReused }),
      opts.isCancelled
    );

    if (result.success && result.key) {
      if (result.reused) {
        reused++;
        bytesReused += result.manifest?.bytes ?? 0;
      } else {
        stored++;
      }
      bytesCopied += result.bytesCopied ?? 0;
      mods.push({
        ...want,
        payload: result.key,
        payloadHash: result.manifest?.hash,
        sizeBytes: result.manifest?.bytes,
        // What THIS publisher knows wins over what the payload's manifest happens to record.
        // A reused payload returns the manifest written by whoever stored it FIRST, so
        // reading these off it meant a sourceUrl this machine knew was silently dropped the
        // moment someone else had already stored those bytes. That is the one field that
        // still matters after Forge is gone — it is how you find the mod when the payload
        // is not carried.
        license: local.license ?? result.manifest?.license,
        sourceUrl: local.sourceUrl ?? result.manifest?.sourceUrl
      });
    } else {
      failed.push({ name: want.name, message: result.message });
      mods.push({ ...want, payload: undefined, payloadHash: undefined });
    }
    modsDone++;
  }

  const carried = mods.filter((m) => m.payload).length;
  const published: Preset = {
    ...preset,
    author: identity,
    updatedAt: new Date().toISOString(),
    // Only true when something is actually carried. Claiming payloads a preset does not have
    // would make apply fail at the exact moment the user was relying on it.
    hasPayloads: carried > 0,
    mods
  };

  try {
    await writeJsonAtomic(storePresetPath(dir, preset.id), published);
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Couldn't write to the store." };
  }

  return {
    success: true,
    preset: published,
    stored,
    reused,
    failed: failed.length ? failed : undefined,
    bytesCopied,
    message:
      `Published "${published.name}" with ${carried} of ${mods.length} mods carried` +
      (reused ? ` (${reused} already in the store)` : "") +
      (bytesCopied ? `, ${formatBytes(bytesCopied)} copied` : "") +
      (failed.length ? `. ${failed.length} could not be gathered.` : ".")
  };
}

/** Reads the raw file for one preset id, without the conflict resolution listStorePresets does. */
async function readStorePresetFile(dir: string, id: string): Promise<Preset | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(storePresetPath(dir, id), "utf-8")) as Preset;
    return parsed?.schema === PRESET_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Phase 3 — installing from payloads
 * ----------------------------------------------------------------------- */

export interface ApplyPayloadsProgress {
  mod: string;
  modsDone: number;
  modsTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface ApplyPayloadsResult {
  success: boolean;
  message: string;
  installed: string[];
  failed: { name: string; message: string }[];
  skipped: { name: string; message: string }[];
  bytesInstalled: number;
}

/**
 * Installs the mods a preset carries but the target install lacks.
 *
 * Additive only. A mod present locally and absent from the preset is left alone: a preset
 * says what a setup needs, not what it forbids, and deleting somebody's mods because they
 * are missing from a list is a far more destructive reading than anyone asked for.
 *
 * `names` narrows it to specific mods, so the UI can offer "install this one" as well as
 * "install everything missing".
 */
export async function applyPresetPayloads(
  dir: string,
  preset: Preset,
  roots: { clientRoot: string; serverRoot: string },
  names: string[] | null,
  onProgress?: (p: ApplyPayloadsProgress) => void,
  isCancelled?: () => boolean
): Promise<ApplyPayloadsResult> {
  const wanted = names ? new Set(names.map((n) => n.toLowerCase())) : null;
  const targets = preset.mods.filter((m) => !wanted || wanted.has(m.name.toLowerCase()));

  const installed: string[] = [];
  const failed: { name: string; message: string }[] = [];
  const skipped: { name: string; message: string }[] = [];
  let bytesInstalled = 0;

  const bytesTotal = targets.reduce((s, m) => s + (m.sizeBytes ?? 0), 0);
  let modsDone = 0;

  for (const mod of targets) {
    if (isCancelled?.()) break;

    if (!mod.payload) {
      // Named but not carried. Honest about which it is: "missing" and "we have it but can't
      // install it" send the user to completely different places.
      skipped.push({
        name: mod.name,
        message: mod.sourceUrl ? `Not carried by this preset — get it from ${mod.sourceUrl}` : "Not carried by this preset."
      });
      modsDone++;
      continue;
    }

    onProgress?.({ mod: mod.name, modsDone, modsTotal: targets.length, bytesDone: bytesInstalled, bytesTotal });

    const result = await applyPayload(dir, mod.payload, roots.clientRoot, roots.serverRoot, {
      enabled: mod.enabled,
      verifyFirst: true
    });

    if (result.success) {
      installed.push(mod.name);
      bytesInstalled += result.bytesCopied ?? 0;

      // Record what was installed, for two reasons. The obvious one: this is a third install
      // path, and both earlier ones shipped recording nothing. The subtle one: a payload
      // install rewrites every file, so mtimes change even when bytes do not, and the
      // ledger's fingerprint is stat-only — without this, installing a preset would mark
      // every mod it touched "stale-record" and go back to trusting what mods say about
      // themselves. Measured: it did exactly that to 5 mods on the reference install.
      const installedPath = installedPathFor(roots, mod);
      if (installedPath) {
        try {
          recordPayloadInstall(roots.clientRoot, {
            id: mod.name,
            type: mod.type,
            installedPath,
            version: mod.version,
            presetName: preset.name,
            payloadHash: mod.payloadHash
          });
        } catch {
          // A ledger entry is worth having but never worth failing an install over.
        }

        // Restore the addon relationship too. Copying the files alone rebuilds a setup that
        // looks identical and has forgotten what attaches to what — and the app then cannot
        // warn the recipient when updating a parent strands one of its addons.
        if (mod.addonOf) {
          try {
            markInstalledAsAddon(
              path.join(roots.clientRoot, ".spt-mod-manager-registry.json"),
              [{ id: mod.name, type: mod.type }],
              {
                parentName: mod.addonOf,
                parentType: mod.addonOfType ?? "server",
                forgeAddonId: mod.forgeAddonId,
                parentConstraint: mod.addonParentConstraint
              }
            );
          } catch {
            /* same reasoning as above */
          }
        }
      }
    } else {
      failed.push({ name: mod.name, message: result.message });
    }
    modsDone++;
  }

  return {
    success: failed.length === 0,
    installed,
    failed,
    skipped,
    bytesInstalled,
    message:
      `Installed ${installed.length} mod(s)` +
      (bytesInstalled ? `, ${formatBytes(bytesInstalled)}` : "") +
      (skipped.length ? `. ${skipped.length} not carried by this preset` : "") +
      (failed.length ? `. ${failed.length} failed` : "") +
      "."
  };
}

/**
 * Where a mod's files end up, which is what the ledger fingerprints.
 *
 * Mirrors resolvePayloadTarget's roots rule rather than restating it loosely: a server mod
 * lives under the SERVER root, a client mod under the CLIENT root, and on a split install
 * those differ.
 */
function installedPathFor(
  roots: { clientRoot: string; serverRoot: string },
  mod: PresetMod
): string | null {
  if (mod.type === "server") {
    return path.join(roots.serverRoot, "user", mod.enabled ? "mods" : "mods.disabled", mod.name);
  }
  return path.join(roots.clientRoot, "BepInEx", mod.enabled ? "plugins" : "plugins.disabled", mod.name);
}

/** Every payload key any preset in the store still refers to. */
export async function payloadKeysInUse(dir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const entry of await listStorePresets(dir)) {
    for (const mod of entry.preset.mods) if (mod.payload) keys.add(mod.payload);
  }
  return keys;
}
