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
import { checkSptCompatibility } from "./modManager";

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

  // An addon that declares nothing at all is a maybe, not a no.
  const silent = withLink.find((v) => !v.modConstraint?.trim());
  return silent ? { version: silent, fit: "unconstrained" } : undefined;
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
  if (!addonConstraint?.trim() || !parentVersion?.trim()) return "unknown";
  const verdict = checkSptCompatibility(addonConstraint, parentVersion);
  return verdict === "compatible" ? "fits" : verdict === "incompatible" ? "outgrown" : "unknown";
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
