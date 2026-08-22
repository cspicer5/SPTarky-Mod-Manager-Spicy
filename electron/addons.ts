/**
 * Addons — compatibility and companion mods (v1.2.2).
 *
 * An addon is a mod whose reason to exist is another mod: "CAG BRNVG patch" makes WTT's
 * Clothing and Gear work with Borkel's night vision; "Miyako Carry Service Fika Addon" makes
 * a mod work under Fika co-op. Forge models them as a separate entity with their own
 * `/addon/` namespace, and two fields that exist nowhere else:
 *
 *   modId                  the PARENT mod the addon attaches to
 *   versions[].modConstraint  which versions of that parent each build fits
 *
 * That second field is the interesting one. An addon is pinned to a range of PARENT
 * versions, so the newest addon build is not necessarily the one that fits the parent you
 * have — Quick-Sell 2.3.0 wants Show Me The Money ~2.7.0, while 2.2.2 wants <2.7.0. This is
 * the same lesson the SPT version picker learned about mods, one level down, and the same
 * clause parser answers it.
 *
 * ## Two sources, because one of them is about to disappear
 *
 * **The harvest** (`data/forge-addons.json`) is the catalogue: what exists, what it attaches
 * to, and where to download it. Captured 2026-08-06; Forge shuts down on the 10th, and the
 * mod-to-mod relationship it records cannot be rebuilt afterwards at any cost. The mods
 * themselves do not declare it — 0 of 27 server mods on the reference install declare any
 * dependency — and the mod API has no dependency field at all.
 *
 * **The installed files** are the ground truth for what is actually wired to what, and they
 * keep working forever. BepInEx plugins declare `[BepInDependency("some.mod.guid")]`, and
 * those GUIDs are readable straight out of the assembly: 18 of 31 client plugins on the
 * reference install reference another installed mod this way.
 *
 * The two answer different questions — "what could I add?" and "what do I already have, and
 * what is it attached to?" — so both are kept rather than one being derived from the other.
 */
import fs from "fs";
import path from "path";
import { ModInfo, ModType } from "./types";
import { checkSptCompatibility, compareVersions } from "./modManager";
import { getRegistryApiBase } from "./registry";

export const ADDON_CATALOGUE_FILE = "forge-addons.json";

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
  /** The parent mod's Forge id. */
  modId?: number;
  /** Its parent was removed from Forge. The relationship is still worth showing. */
  isDetached?: boolean;
  publishedAt?: string;
  updatedAt?: string;
  versions: AddonVersion[];
}

/* --------------------------------------------------------------------------
 * The catalogue
 * ----------------------------------------------------------------------- */

let cachedCatalogue: ForgeAddon[] | null = null;

/**
 * Reads the harvested addon catalogue.
 *
 * Looks in the packaged resources first, then the repo — the same shape the Forge directory
 * uses, and for the same reason: a packaged build has no `data/` beside the source.
 */
export function loadAddonCatalogue(searchPaths: string[] = []): ForgeAddon[] {
  if (cachedCatalogue) return cachedCatalogue;

  const candidates = [
    ...searchPaths,
    path.join(process.resourcesPath ?? "", "data", ADDON_CATALOGUE_FILE),
    path.join(__dirname, "..", "data", ADDON_CATALOGUE_FILE),
    path.join(__dirname, "..", "..", "data", ADDON_CATALOGUE_FILE)
  ];

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      const list = Array.isArray(parsed) ? parsed : parsed.addons;
      if (Array.isArray(list)) {
        cachedCatalogue = list as ForgeAddon[];
        return cachedCatalogue;
      }
    } catch {
      /* try the next location */
    }
  }
  cachedCatalogue = [];
  return cachedCatalogue;
}

/** Test seam, and lets a redeployed catalogue be picked up without a restart. */
export function resetAddonCatalogue(): void {
  cachedCatalogue = null;
  liveCatalogueFetchedAt = 0;
}

/* --------------------------------------------------------------------------
 * The LIVE catalogue
 *
 * The harvest was captured while Forge was the only source, and every one of its 166
 * download links is a Forge-proxied URL of the form
 * forge.sp-tarkov.com/addon/download/<id>/<slug>/<version>. All 166 stopped resolving when
 * Forge went dark — so a catalogue that still worked for BROWSING would have failed on
 * every INSTALL, and failed at the download step, after the user had already picked a
 * version. Nothing in the harvest itself reveals this: the entries look complete.
 *
 * The live API answers with each version's ORIGINAL upstream link (overwhelmingly GitHub
 * releases), which is both what survives and what the app would rather have anyway.
 *
 * So: prefer live, fall back to the harvest. The harvest keeps its original job — the
 * mod-to-mod relationships and parent version constraints that exist nowhere else — and
 * stays the answer when the network or the registry is down.
 * ----------------------------------------------------------------------- */

let liveCatalogueFetchedAt = 0;

/** Re-fetched at most this often; the catalogue changes on the order of days. */
const LIVE_CATALOGUE_TTL_MS = 30 * 60 * 1000;

function mapLiveAddon(raw: any): ForgeAddon | null {
  const id = Number(raw?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const versions: AddonVersion[] = Array.isArray(raw?.versions)
    ? raw.versions
        .map((v: any) => ({
          version: String(v?.version ?? ""),
          link: typeof v?.link === "string" ? v.link : undefined,
          bytes: typeof v?.content_length === "number" ? v.content_length : undefined,
          // The field that exists nowhere else: which PARENT versions this build fits.
          modConstraint: typeof v?.mod_version_constraint === "string" ? v.mod_version_constraint : undefined,
          publishedAt: typeof v?.published_at === "string" ? v.published_at : undefined
        }))
        .filter((v: AddonVersion) => v.version)
    : [];
  return {
    id,
    name: String(raw?.name ?? `Addon ${id}`),
    slug: typeof raw?.slug === "string" ? raw.slug : undefined,
    teaser: typeof raw?.teaser === "string" ? raw.teaser : undefined,
    owner: typeof raw?.owner?.name === "string" ? raw.owner.name : undefined,
    downloads: typeof raw?.downloads === "number" ? raw.downloads : undefined,
    detailUrl: typeof raw?.detail_url === "string" ? raw.detail_url : undefined,
    modId: Number.isFinite(Number(raw?.mod_id)) ? Number(raw.mod_id) : undefined,
    isDetached: raw?.is_detached === true,
    publishedAt: typeof raw?.published_at === "string" ? raw.published_at : undefined,
    updatedAt: typeof raw?.updated_at === "string" ? raw.updated_at : undefined,
    versions
  };
}

/**
 * Fetches the catalogue from the registry, replacing the harvest for this session.
 *
 * Returns the number of addons on success and null on any failure — a failure is NOT an
 * error to show. The harvest stays loaded and browsing carries on; only the download links
 * are older. Bounded by `maxPages` so a paginating bug cannot spin.
 */
export async function refreshAddonCatalogue(options: { force?: boolean; maxPages?: number } = {}): Promise<number | null> {
  if (!options.force && liveCatalogueFetchedAt && Date.now() - liveCatalogueFetchedAt < LIVE_CATALOGUE_TTL_MS) {
    return cachedCatalogue?.length ?? null;
  }
  const maxPages = options.maxPages ?? 20;
  const collected: ForgeAddon[] = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(`${getRegistryApiBase()}/addons`);
      url.searchParams.set("include", "versions");
      url.searchParams.set("per_page", "50");
      url.searchParams.set("page", String(page));
      const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json?.data) ? json.data : [];
      for (const row of rows) {
        const mapped = mapLiveAddon(row);
        if (mapped) collected.push(mapped);
      }
      const lastPage = Number(json?.meta?.last_page ?? 1);
      if (!Number.isFinite(lastPage) || page >= lastPage) break;
    }
  } catch {
    return null;
  }
  // An empty answer is treated as a failure rather than as "there are no addons": replacing
  // a working harvest with nothing would silently empty the panel.
  if (collected.length === 0) return null;
  cachedCatalogue = collected;
  liveCatalogueFetchedAt = Date.now();
  return collected.length;
}

/** Whether the catalogue in memory came from the registry rather than the harvest. */
export function isAddonCatalogueLive(): boolean {
  return liveCatalogueFetchedAt > 0;
}

/**
 * Picks the addon build that fits the parent version actually installed.
 *
 * Returns nothing rather than something that will not work: an addon built for a different
 * major version of its parent is not a fallback, it is a crash with extra steps. This mirrors
 * pickForgeVersionForSpt, which learned the same thing about SPT versions.
 */
export function pickAddonVersionForParent(
  addon: ForgeAddon,
  parentVersion: string | undefined
): { version: AddonVersion; fit: "declared" | "unconstrained" } | undefined {
  const withLink = addon.versions.filter((v) => v.link);
  if (withLink.length === 0) return undefined;

  // No idea what the parent is: the newest build is the only defensible guess, and the
  // caller is told the fit was never actually checked.
  if (!parentVersion) return { version: withLink[0], fit: "unconstrained" };

  const declared = withLink.find((v) => checkSptCompatibility(v.modConstraint, parentVersion) === "compatible");
  if (declared) return { version: declared, fit: "declared" };

  /*
   * An addon that declares nothing is a maybe, not a no — and a WILDCARD declares nothing.
   *
   * `*` means "any parent version", but the range parser answers "unknown" for it rather than
   * "compatible", so a build constrained to `*` matched neither branch and the addon came back
   * as having no build at all. That is not a harmless miss: the caller reads "nothing fits your
   * parent" as evidence the patch has been folded into the mod, so CAG BRNVG patch — which fits
   * anything — was reported as absorbed into WTT-CAG and due for removal.
   *
   * Treated as unconstrained rather than as compatible, because that is what it is: the build
   * says nothing about which parent it wants, and the caller is told the fit was never checked.
   */
  const silent = withLink.find((v) => declaresNoParentVersion(v.modConstraint));
  return silent ? { version: silent, fit: "unconstrained" } : undefined;
}

/** Constraints that say "any version", which is the same as saying nothing. */
function declaresNoParentVersion(constraint: string | undefined): boolean {
  const trimmed = constraint?.trim().toLowerCase() ?? "";
  return trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "any";
}

export interface AddonSuggestion {
  addon: ForgeAddon;
  /** The installed mod this addon attaches to. */
  parentName: string;
  parentType: ModType;
  parentVersion?: string;
  /** The build that fits, when one does. */
  pick?: AddonVersion;
  fit: "declared" | "unconstrained" | "none";
  /** Already installed here, matched by the folder the addon installs as. */
  installed: boolean;
}

/**
 * Which catalogued addons attach to something in this install.
 *
 * Needs the Forge match cache, because an addon points at a Forge mod ID and the install
 * knows only folder names. That mapping is exactly what was persisted before the shutdown.
 */
export function suggestAddons(
  mods: ModInfo[],
  forgeIdByFolder: Record<string, string>,
  catalogue: ForgeAddon[] = loadAddonCatalogue(),
  installedAddonIds: Set<number> = new Set()
): AddonSuggestion[] {
  // A Forge id can map to several folders — a mod shipping a server and a client half shares
  // one id. Prefer the half with a version, since that is what a constraint is checked
  // against; a client DLL often declares nothing.
  const byForgeId = new Map<string, ModInfo[]>();
  for (const mod of mods) {
    const forgeId = forgeIdByFolder[mod.id] ?? forgeIdByFolder[mod.originalName];
    if (!forgeId) continue;
    const list = byForgeId.get(String(forgeId)) ?? [];
    list.push(mod);
    byForgeId.set(String(forgeId), list);
  }

  const out: AddonSuggestion[] = [];
  for (const addon of catalogue) {
    if (addon.modId === undefined) continue;
    const parents = byForgeId.get(String(addon.modId));
    if (!parents?.length) continue;

    const parent = parents.find((p) => p.version) ?? parents[0];
    const picked = pickAddonVersionForParent(addon, parent.version);
    out.push({
      addon,
      parentName: parent.id,
      parentType: parent.type,
      parentVersion: parent.version,
      pick: picked?.version,
      fit: picked?.fit ?? "none",
      installed: installedAddonIds.has(addon.id)
    });
  }

  // Ones that fit come first; a "nothing here works with your version" row is still worth
  // showing, because the answer is "update the parent", not "this addon does not exist".
  const rank = { declared: 0, unconstrained: 1, none: 2 } as const;
  return out.sort(
    (a, b) => rank[a.fit] - rank[b.fit] || (b.addon.downloads ?? 0) - (a.addon.downloads ?? 0)
  );
}

/* --------------------------------------------------------------------------
 * The addon ledger
 * ----------------------------------------------------------------------- */

/**
 * A record of an addon this app installed.
 *
 * Kept SEPARATELY from the mod registry, and written at install time, because an addon
 * frequently has no folder of its own. Manimal's Icebreaker Backport Fika Sync unpacks
 * straight into the parent's `ManimalIcebreaker` folders; the CAG BRNVG patch unpacks into
 * `BorkelRNVG`. Working out what was installed by diffing folder names before and after
 * therefore finds NOTHING, and the addon vanishes — which is exactly what happened: the
 * panel kept offering an addon that was already installed.
 *
 * This is the version ledger's lesson a second time. At install time the app knows precisely
 * what it did; every attempt to reconstruct that afterwards from the files is a guess, and
 * here the guess has no evidence to work from at all.
 */
export interface InstalledAddonRecord {
  /** Forge's addon id, when it came from the catalogue. */
  forgeAddonId?: number;
  name: string;
  version?: string;
  parentName: string;
  parentType: ModType;
  /** Range of parent versions this build declares it fits, e.g. "~2.7.0". */
  parentConstraint?: string;
  installedAt: string;
  source: "forge" | "github" | "file";
  /** Folders that appeared. Empty when the addon merged into its parent. */
  folders: { id: string; type: ModType }[];
  /** True when nothing new appeared, so the addon lives inside its parent's folders. */
  mergedIntoParent: boolean;
  /**
   * The files this addon actually put into its parent's folder, relative to that folder.
   *
   * Recorded because the alternative is inference, and the inference was wrong. Whether a merged
   * addon still exists used to be decided by comparing timestamps — if the parent was installed
   * after the addon, the addon must have been overwritten — which cannot tell a real reinstall
   * from the parent's own stamp being touched, and reported addons as wiped that were sitting on
   * disk untouched.
   *
   * With the file list the question stops being a guess: look, and see whether they are there.
   * Absent on records written before this existed, which fall back to the old rule.
   */
  parentFiles?: string[];
}

/**
 * Every file under a folder, relative and forward-slashed, for diffing before against after.
 *
 * Returns an empty array for a missing folder rather than throwing: "the parent has no folder"
 * is an ordinary state for an addon whose parent is a loose .dll.
 */
export function listFilesRelative(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/**
 * Which of an addon's recorded files are no longer on disk.
 *
 * The factual replacement for the timestamp guess. An addon is gone when its files are gone —
 * nothing else needs to be believed about install order.
 */
export function missingAddonFiles(parentDir: string, record: InstalledAddonRecord): string[] {
  if (!record.parentFiles?.length) return [];
  return record.parentFiles.filter((rel) => !fs.existsSync(path.join(parentDir, ...rel.split("/"))));
}

const addonLedgerPath = (clientRoot: string) => path.join(clientRoot, ".spt-mod-manager-addons.json");

export function loadAddonLedger(clientRoot: string): InstalledAddonRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(addonLedgerPath(clientRoot), "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Identity is the Forge id when there is one, and the name-plus-parent otherwise. */
function sameAddon(a: InstalledAddonRecord, b: Pick<InstalledAddonRecord, "forgeAddonId" | "name" | "parentName">) {
  if (a.forgeAddonId !== undefined && b.forgeAddonId !== undefined) return a.forgeAddonId === b.forgeAddonId;
  return a.name.toLowerCase() === b.name.toLowerCase() && a.parentName.toLowerCase() === b.parentName.toLowerCase();
}

export function recordAddonInstall(clientRoot: string, record: InstalledAddonRecord): void {
  const ledger = loadAddonLedger(clientRoot).filter((e) => !sameAddon(e, record));
  ledger.push(record);
  fs.writeFileSync(addonLedgerPath(clientRoot), JSON.stringify(ledger, null, 2), "utf-8");
}

/**
 * Addons whose files a later reinstall of their parent has wiped out.
 *
 * An addon that unpacks into its parent's folder has no separate existence, so reinstalling
 * the parent replaces the folder and takes the addon with it — silently, because nothing about
 * the parent's own row changes. Measured: reinstalling Borkel's RNVG to repair a version left
 * zero files of the CAG BRNVG patch behind, and nothing said so.
 *
 * Decided by timestamps rather than by looking for files: the addon's files are indistinguishable
 * from the parent's once merged, which is the whole problem. If the parent was installed AFTER
 * the addon, the addon is gone.
 */
export function addonsNeedingReinstall(
  ledger: InstalledAddonRecord[],
  parentInstalledAt: (name: string, type: ModType) => string | undefined,
  /**
   * Where each parent's folder is, so its files can actually be looked at. Optional only for
   * callers that predate the file check; without it this falls back to comparing timestamps.
   */
  parentDir?: (name: string, type: ModType) => string | undefined
): InstalledAddonRecord[] {
  return ledger.filter((record) => {
    if (!record.mergedIntoParent) return false; // it has its own folder, so it survived

    // Look at the files first. This is a fact, and it replaces an inference that was measurably
    // wrong: comparing timestamps cannot tell a real parent reinstall from the parent's stamp
    // being touched by a LATER addon merging into the same folder, and on the reference install
    // that reported a patch as wiped which had never been touched.
    const dir = parentDir?.(record.parentName, record.parentType);
    if (dir && record.parentFiles?.length) return missingAddonFiles(dir, record).length > 0;

    // Records written before file lists existed still get the old rule, which is better than
    // nothing for them and now applies to nothing else.
    const parentAt = parentInstalledAt(record.parentName, record.parentType);
    if (!parentAt || !record.installedAt) return false;
    if (parentAt.localeCompare(record.installedAt) <= 0) return false;

    /*
     * Before believing that stamp, check what actually wrote it.
     *
     * A merged addon writes into its parent's folder, so the install machinery stamps the PARENT
     * too — within a second of the addon's own record. A parent whose stamp coincides with some
     * other addon's install was not reinstalled at all; it was patched, and reading that as a
     * reinstall condemns every addon that went in earlier.
     *
     * Measured: BorkelRNVG is stamped 255ms BEFORE the second of its two patches, and the first
     * patch has been reported as needing a reinstall ever since — with nothing wiped and nothing
     * to do. New installs no longer bump the parent at all; this rescues the records that
     * already carry the bumped stamp.
     */
    const parentTime = Date.parse(parentAt);
    const writtenByAnotherAddon = ledger.some(
      (other) =>
        other !== record &&
        other.parentName.toLowerCase() === record.parentName.toLowerCase() &&
        other.parentType === record.parentType &&
        other.installedAt &&
        Math.abs(Date.parse(other.installedAt) - parentTime) < 60_000
    );
    return !writtenByAnotherAddon;
  });
}

export function forgetAddon(clientRoot: string, match: { forgeAddonId?: number; name?: string; parentName?: string }): boolean {
  const ledger = loadAddonLedger(clientRoot);
  const kept = ledger.filter(
    (e) =>
      !(
        (match.forgeAddonId !== undefined && e.forgeAddonId === match.forgeAddonId) ||
        (match.name !== undefined && e.name.toLowerCase() === match.name.toLowerCase())
      )
  );
  if (kept.length === ledger.length) return false;
  fs.writeFileSync(addonLedgerPath(clientRoot), JSON.stringify(kept, null, 2), "utf-8");
  return true;
}

/**
 * Version fields of every registry entry, as they were before an install.
 *
 * Taken so an addon install can be stopped from relabelling the mod it patches. Installing
 * the CAG BRNVG patch (v1.0.0) into Borkel's RNVG rewrote that mod's recorded version from
 * 2.1.1 to 1.0.0, and the app then TRUSTED the wrong number over what the files declared —
 * the precise failure the version ledger exists to prevent.
 */
export interface VersionSnapshot {
  [key: string]: {
    installedVersion?: string;
    versionOrigin?: string;
    versionEvidence?: string;
    /**
     * When the PARENT itself was installed — restored along with the version, and for a closely
     * related reason.
     *
     * A merged addon writes into its parent's folder, so the install machinery records that
     * folder and stamps it with a fresh `installedAt`. That timestamp is then read as "the
     * parent was reinstalled", and `addonsNeedingReinstall` concludes that every addon installed
     * BEFORE it has been wiped. Measured on the reference install: installing the second Borkel's
     * RNVG patch stamped BorkelRNVG 255ms before its own record, and the first patch has been
     * reported as needing a reinstall ever since. Nothing was wiped and nothing needed doing.
     */
    installedAt?: string;
  };
}

export function snapshotVersions(registryPath: string): VersionSnapshot {
  const snap: VersionSnapshot = {};
  try {
    for (const e of JSON.parse(fs.readFileSync(registryPath, "utf-8"))) {
      snap[`${e.type}:${String(e.id).toLowerCase()}`] = {
        installedVersion: e.installedVersion,
        versionOrigin: e.versionOrigin,
        versionEvidence: e.versionEvidence,
        installedAt: e.installedAt
      };
    }
  } catch {
    /* no registry yet */
  }
  return snap;
}

/**
 * Puts back any version an addon install overwrote.
 *
 * Only touches entries that ALREADY EXISTED: a folder the addon created for itself is its
 * own, and its version is the addon's. A mod that was already installed is never the addon,
 * so any change to its recorded version during an addon install is wrong by definition.
 */
export function restoreClobberedVersions(registryPath: string, before: VersionSnapshot): string[] {
  let registry: any[];
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch {
    return [];
  }
  const restored: string[] = [];
  for (const entry of registry) {
    const key = `${entry.type}:${String(entry.id).toLowerCase()}`;
    const prior = before[key];
    if (!prior) continue; // created by this install — genuinely the addon's own folder

    // Every version field is compared, not just the number. An addon whose version happens
    // to EQUAL its parent's slips through a version-only check while still rewriting the
    // provenance: Manimal's Icebreaker Fika Sync is 0.2.1 and so is the mod it patches, so
    // the parent kept the right version attributed to entirely the wrong thing.
    const changed =
      entry.installedVersion !== prior.installedVersion ||
      entry.versionOrigin !== prior.versionOrigin ||
      entry.versionEvidence !== prior.versionEvidence ||
      entry.installedAt !== prior.installedAt;
    if (!changed) continue;

    entry.installedVersion = prior.installedVersion;
    entry.versionOrigin = prior.versionOrigin;
    entry.versionEvidence = prior.versionEvidence;
    // The parent was not reinstalled — an addon merged into its folder. Leaving the bumped
    // stamp makes every addon installed before this one look wiped, permanently.
    if (prior.installedAt) entry.installedAt = prior.installedAt;
    restored.push(`${entry.id} [${entry.type}]`);
  }
  if (restored.length) fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
  return restored;
}

/* --------------------------------------------------------------------------
 * Recording that something IS an addon
 * ----------------------------------------------------------------------- */

/**
 * What the app knows about an addon it just installed.
 *
 * Written to the registry rather than inferred later, for the reason the version ledger
 * exists: at install time the app knows exactly what it did, and every attempt to reconstruct
 * that afterwards from the files is a guess. An addon installed from a local zip has no other
 * way of ever being known as an addon at all.
 */
export interface AddonInstallInfo {
  parentName: string;
  parentType: ModType;
  forgeAddonId?: number;
  parentConstraint?: string;
}

/**
 * Marks already-installed folders as addons of a parent.
 *
 * Takes the folder names the install actually produced rather than assuming one: an addon
 * archive can drop a server part and a client part, exactly like a mod, and marking only the
 * one the caller happened to name would leave the other looking like an unrelated mod.
 */
export function markInstalledAsAddon(
  registryPath: string,
  installedFolders: { id: string; type: ModType }[],
  info: AddonInstallInfo
): number {
  let registry: any[];
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch {
    return 0;
  }
  let marked = 0;
  for (const folder of installedFolders) {
    const entry = registry.find((e) => e.id === folder.id && e.type === folder.type);
    if (!entry) continue;
    // A mod is never its own addon. The parent folder can legitimately appear in the install
    // result when an addon ships alongside a copy of what it patches.
    if (entry.id === info.parentName && entry.type === info.parentType) continue;
    entry.addonOf = info.parentName;
    entry.addonOfType = info.parentType;
    entry.forgeAddonId = info.forgeAddonId;
    entry.addonParentConstraint = info.parentConstraint;
    marked++;
  }
  if (marked > 0) fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
  return marked;
}

/** Undoes the link, returning the row to being an ordinary mod. */
export function clearAddonMark(registryPath: string, id: string, type: ModType): boolean {
  let registry: any[];
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch {
    return false;
  }
  const entry = registry.find((e) => e.id === id && e.type === type);
  if (!entry?.addonOf) return false;
  delete entry.addonOf;
  delete entry.addonOfType;
  delete entry.forgeAddonId;
  delete entry.addonParentConstraint;
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
  return true;
}

/**
 * Whether an installed addon still suits the parent that is installed now.
 *
 * The failure this catches is quiet and specific: the parent gets updated, the addon does
 * not, and the pair stops matching without anything announcing it. Quick-Sell 2.2.2 declares
 * `<2.7.0`, so updating Show Me The Money to 2.7.0 silently invalidates it.
 */
export function checkAddonFit(
  addonConstraint: string | undefined,
  parentVersion: string | undefined
): "fits" | "outgrown" | "unknown" {
  if (declaresNoParentVersion(addonConstraint) || !parentVersion?.trim()) return "unknown";
  const verdict = checkSptCompatibility(addonConstraint, parentVersion);
  return verdict === "compatible" ? "fits" : verdict === "incompatible" ? "outgrown" : "unknown";
}


/* --------------------------------------------------------------------------
 * Are the installed addons out of date?
 * ----------------------------------------------------------------------- */

/**
 * What an installed addon's situation is, once the catalogue has been consulted.
 *
 * Deliberately more than "update / no update", because an addon is not a mod: it is built against
 * a PARENT VERSION, and the interesting cases are all about that relationship rather than about
 * the addon's own number.
 */
export type AddonUpdateStatus =
  /** The installed build is the best one offered for the parent you have. */
  | "up-to-date"
  /** A newer build exists AND it fits the parent you have. The only status that is a download. */
  | "update"
  /**
   * A newer build exists but wants a NEWER PARENT. Not an update anyone can take: installing it
   * would put an addon built for a mod version you do not run into the install. The parent is the
   * thing to update, and saying so is more use than either offering it or hiding it.
   */
  | "needs-parent-update"
  /**
   * Still listed, but nothing it offers fits your parent at all. Usually means the parent has
   * moved past every build there is — which is what "the addon was folded into the mod" looks
   * like from out here.
   */
  | "no-build-for-parent"
  /** Its id no longer resolves. Withdrawn, or absorbed into the parent and taken down. */
  | "delisted"
  /** The catalogue says the mod it patches was removed. */
  | "detached"
  /** The parent is not installed here, so there is nothing for it to attach to. */
  | "parent-missing"
  /** Installed from a file: no catalogue id, so it cannot be checked at all. */
  | "unknown";

export interface AddonUpdateRow {
  name: string;
  forgeAddonId?: number;
  parentName: string;
  parentType: ModType;
  installedVersion?: string;
  parentVersion?: string;
  status: AddonUpdateStatus;
  /** The build to install. Present only for `update` — the one status that is actionable. */
  availableVersion?: string;
  downloadLink?: string;
  /** The newest build's number and the parent it wants, when THAT is what is in the way. */
  blockedVersion?: string;
  requiresParent?: string;
  detailUrl?: string;
  detail: string;
}

/**
 * Checks every installed addon against the catalogue.
 *
 * Pure: the caller refreshes the catalogue and supplies the installed parent versions, so this is
 * testable without a network or an install. That matters because the rules below ARE the feature,
 * and every one of them is a judgement about somebody's game.
 *
 * The rule that shapes all of it: **an addon update is filtered by the PARENT's version, exactly
 * as a mod update is filtered by the SPT version.** Offering the newest build regardless is the
 * same fault that shipped once already in preset sync — it installs something built for a version
 * you do not have. Measured on the reference install: "NVG support for WTT-Content Backport"
 * 1.1.0 requires parent ~3.0.0 while the parent is 2.0.0, so the honest answer is "update the
 * parent first", not "here is an update".
 */
export function checkAddonUpdates(
  ledger: InstalledAddonRecord[],
  catalogue: ForgeAddon[],
  parentVersionOf: (name: string, type: ModType) => string | undefined,
  /** Whether the parent is installed at all — separate from its version, which may be unknown. */
  parentInstalled: (name: string, type: ModType) => boolean
): AddonUpdateRow[] {
  const byId = new Map<number, ForgeAddon>();
  for (const addon of catalogue) byId.set(addon.id, addon);

  return ledger.map((record): AddonUpdateRow => {
    const base = {
      name: record.name,
      forgeAddonId: record.forgeAddonId,
      parentName: record.parentName,
      parentType: record.parentType,
      installedVersion: record.version,
      parentVersion: parentVersionOf(record.parentName, record.parentType)
    };

    if (record.forgeAddonId === undefined) {
      return {
        ...base,
        status: "unknown",
        detail: `Installed from a file, so there is no catalogue entry to compare it against.`
      };
    }

    const addon = byId.get(record.forgeAddonId);
    if (!addon) {
      // The scenario with no other signal: an addon absorbed into its parent is simply taken
      // down. Stated as the two possibilities it actually is, rather than guessed between.
      return {
        ...base,
        status: "delisted",
        detail:
          `No longer listed on its own. It has either been withdrawn or folded into ${record.parentName} itself — ` +
          `check that mod's page, and if it is built in now, drop this from the list.`
      };
    }

    const withBase = { ...base, detailUrl: addon.detailUrl };

    if (addon.isDetached) {
      return {
        ...withBase,
        status: "detached",
        detail: `The catalogue says the mod this patches was removed, so this addon stands alone now.`
      };
    }

    if (!parentInstalled(record.parentName, record.parentType)) {
      return {
        ...withBase,
        status: "parent-missing",
        detail: `${record.parentName} is not installed here, so this patch has nothing to attach to.`
      };
    }

    const parentVersion = base.parentVersion;
    const best = pickAddonVersionForParent(addon, parentVersion);
    // The newest build overall, which tells "nothing newer exists" apart from "something newer
    // exists and you cannot have it yet".
    const newest = addon.versions.find((v) => v.link);

    if (!best) {
      return {
        ...withBase,
        status: "no-build-for-parent",
        blockedVersion: newest?.version,
        requiresParent: newest?.modConstraint,
        detail: parentVersion
          ? `Nothing it offers is built for ${record.parentName} ${parentVersion}. That usually means the patch is ` +
            `part of ${record.parentName} itself now — check before reinstalling it.`
          : `Nothing it offers could be matched to ${record.parentName}, whose version is unknown here.`
      };
    }

    const offered = best.version.version;
    const newerThanInstalled = record.version ? compareVersions(offered, record.version) > 0 : true;

    if (newerThanInstalled) {
      return {
        ...withBase,
        status: "update",
        availableVersion: offered,
        downloadLink: best.version.link,
        detail:
          best.fit === "declared"
            ? `${offered} is available and is built for ${record.parentName} ${parentVersion}.`
            : `${offered} is available. It declares no parent version, so whether it suits ` +
              `${record.parentName} ${parentVersion ?? "as installed"} is not stated.`
      };
    }

    // Nothing newer FITS. If something newer exists at all, the parent is what is holding it
    // back — which is the thing worth saying.
    if (newest && record.version && compareVersions(newest.version, record.version) > 0) {
      return {
        ...withBase,
        status: "needs-parent-update",
        blockedVersion: newest.version,
        requiresParent: newest.modConstraint,
        detail:
          `${newest.version} is out, but it needs ${record.parentName} ${newest.modConstraint ?? "a newer version"} ` +
          `and you have ${parentVersion ?? "an unknown version"}. Update ${record.parentName} first and this follows.`
      };
    }

    return {
      ...withBase,
      status: "up-to-date",
      detail: `${record.version ?? offered} is the newest build for ${record.parentName} ${parentVersion ?? "as installed"}.`
    };
  });
}

/* --------------------------------------------------------------------------
 * What is already wired to what
 * ----------------------------------------------------------------------- */

export interface AddonLink {
  /** The mod that depends on something. */
  name: string;
  type: ModType;
  /** The GUID it declares a dependency on. */
  guid: string;
  /** The installed mod owning that GUID, when there is one. */
  parentName?: string;
  parentType?: ModType;
  /** How this was established. Same provenance ladder as everything else in the app. */
  method: "manual" | "declared-guid" | "same-archive";
}

/**
 * Mod GUIDs referenced inside a .NET assembly.
 *
 * BepInEx stores `[BepInDependency("guid")]` arguments as strings in the assembly's heaps, so
 * they can be read without a metadata parser. This is deliberately a scrape rather than a
 * parse, and the results are therefore treated as CANDIDATES: a match only counts once the
 * GUID turns out to belong to another installed mod, which no coincidence realistically
 * survives. That filter is what makes a crude extraction trustworthy.
 */
export function guidsReferencedIn(dllPath: string): string[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(dllPath);
  } catch {
    return [];
  }
  // latin1 keeps every byte addressable as a character, so UTF-8 and UTF-16 literals are both
  // reachable without deciding which the file used.
  const text = buf.toString("latin1");
  const found = new Set<string>();
  const re = /[a-zA-Z][a-zA-Z0-9]{1,20}(?:\.[a-zA-Z0-9_-]{2,30}){1,4}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0];
    if (s.length > 60) continue;
    // Filenames and framework namespaces dominate the raw hits and are never mod GUIDs.
    if (/\.(dll|exe|json|cs|resources|pdb|xml|png|dat|txt|cfg|bundle|jpg|md)$/i.test(s)) continue;
    if (/^(System|Microsoft|Unity|UnityEngine|Newtonsoft|Mono|Comfort|EFT|BepInEx|HarmonyLib|JetBrains|Internal|Google|Bouncy)\./i.test(s)) continue;
    found.add(s);
  }
  return [...found];
}

/** Every .dll worth reading for one mod, bounded so a 931-file mod cannot dominate a scan. */
function assembliesFor(clientRoot: string, mod: ModInfo, limit = 8): string[] {
  const dirs = [
    path.join(clientRoot, "BepInEx", "plugins"),
    path.join(clientRoot, "BepInEx", "plugins.disabled")
  ];
  const out: string[] = [];
  for (const dir of dirs) {
    const target = path.join(dir, mod.id);
    if (!fs.existsSync(target)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (target.toLowerCase().endsWith(".dll")) out.push(target);
      continue;
    }
    // Breadth-first and capped: a plugin's own assembly is at or near the top, while the
    // hundreds of files underneath a content mod are bundles, not code.
    const queue = [target];
    while (queue.length && out.length < limit) {
      const current = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(current, e.name);
        if (e.isDirectory()) queue.push(p);
        else if (e.name.toLowerCase().endsWith(".dll") && out.length < limit) out.push(p);
      }
    }
  }
  return out;
}

/**
 * Works out which installed mods are attached to which, from the files themselves.
 *
 * Needs no Forge and no running server, so it is the half of this feature that still works
 * after the shutdown. Deliberately NOT part of `scanMods`: reading assemblies is far more
 * expensive than listing folders, and the scan runs constantly.
 */
export function detectAddonLinks(
  clientRoot: string,
  mods: ModInfo[],
  manualLinks: Record<string, string> = {}
): AddonLink[] {
  const ownerOfGuid = new Map<string, ModInfo>();
  for (const mod of mods) {
    if (mod.guid) ownerOfGuid.set(mod.guid.toLowerCase(), mod);
  }

  const links: AddonLink[] = [];
  const seen = new Set<string>();

  for (const mod of mods) {
    // The user's own judgement outranks anything derived, exactly as a manual Forge pin
    // outranks every matching strategy.
    const manual = manualLinks[`${mod.type}:${mod.id.toLowerCase()}`];
    if (manual) {
      const parent = mods.find((m) => m.id.toLowerCase() === manual.toLowerCase());
      links.push({
        name: mod.id,
        type: mod.type,
        guid: parent?.guid ?? "",
        parentName: parent?.id ?? manual,
        parentType: parent?.type,
        method: "manual"
      });
      seen.add(`${mod.type}:${mod.id.toLowerCase()}`);
      continue;
    }

    if (mod.type !== "client") continue; // only assemblies declare dependencies

    for (const dll of assembliesFor(clientRoot, mod)) {
      for (const guid of guidsReferencedIn(dll)) {
        const owner = ownerOfGuid.get(guid.toLowerCase());
        // Self-references are how a plugin declares its OWN guid, not a dependency.
        if (!owner || owner.id === mod.id) continue;
        const key = `${mod.type}:${mod.id.toLowerCase()}->${owner.type}:${owner.id.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          name: mod.id,
          type: mod.type,
          guid,
          parentName: owner.id,
          parentType: owner.type,
          method: "declared-guid"
        });
      }
    }
  }

  return links;
}

/**
 * Mods a plugin knows how to work with, that are not installed here.
 *
 * Called "integrations" and NOT "missing dependencies", which is what it looks like at first
 * glance. `[BepInDependency]` carries a flag saying whether the dependency is hard or soft,
 * and a scrape of the string heap cannot see that flag — so every hit is ambiguous.
 *
 * The reference install settles which it usually is. It reports four: DynamicMaps knowing
 * about SamSWAT's Helicopter Crash Sites, UI Fixes knowing about MergeConsumables and PIT
 * Fireteam, and so on. That install runs, and a missing HARD dependency stops BepInEx loading
 * the plugin at all — so these are soft by demonstration. Labelling them "missing" would
 * raise four alarms about a working setup.
 *
 * Framed as discovery, it is genuinely useful: these are mods that would light up extra
 * behaviour in something already installed.
 *
 * Only GUIDs present in the Forge catalogue count. An unresolvable dotted string is far more
 * likely to be a namespace the scrape picked up than a real mod, and guessing otherwise would
 * bury the real answers in noise.
 */
export function findKnownIntegrations(
  clientRoot: string,
  mods: ModInfo[],
  guidIsKnownMod: (guid: string) => { id: number; name: string } | undefined
): { name: string; type: ModType; guid: string; forgeId: number; forgeName: string }[] {
  const installedGuids = new Set(mods.filter((m) => m.guid).map((m) => m.guid!.toLowerCase()));
  const out: { name: string; type: ModType; guid: string; forgeId: number; forgeName: string }[] = [];
  const seen = new Set<string>();

  for (const mod of mods) {
    if (mod.type !== "client") continue;
    for (const dll of assembliesFor(clientRoot, mod)) {
      for (const guid of guidsReferencedIn(dll)) {
        const lower = guid.toLowerCase();
        if (installedGuids.has(lower)) continue;
        const known = guidIsKnownMod(guid);
        if (!known) continue;
        const key = `${mod.id.toLowerCase()}->${lower}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: mod.id, type: mod.type, guid, forgeId: known.id, forgeName: known.name });
      }
    }
  }
  return out;
}
