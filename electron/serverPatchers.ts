/**
 * Prepatchers pulled from the server along with the plugin they belong to.
 *
 * The companion served BepInEx/plugins and user/mods only until 1.3.0, so a plugin pulled from the
 * server arrived without its prepatcher. That is the same fault that crashed a Fika headless
 * client: BlackDiv's prepatcher references MoreBotsPrepatch, BepInEx skips a prepatcher whose
 * references do not resolve, and the game then fails at raid start on an enum value that was never
 * added. A pull now brings
 *   - the prepatchers the SERVER's own ledgers record arriving with the plugin (or, without those
 *     ledgers, that match it by name — the same rule the local install uses), and
 *   - any prepatcher those then reference that this install lacks and the server has,
 * checked by reading the pulled assemblies' references on this machine, after they land.
 *
 * Never SPT's own prepatcher: each install gets that from its own SPT.
 */
import path from "path";
import type { RemoteMod } from "./companion";
import { attributePatchersFromLedgers, checkPatcherReferences, isSptOwnPatcher } from "./modManager";
import { installModFromServer, listServerModFiles, type ServerPullOptions } from "./serverFiles";

export interface ServerPatcherSource {
  clientMods?: RemoteMod[];
  remoteLedgers?: { registry: unknown[]; installManifest: Record<string, string[]> };
}

/** The server's running prepatchers (BepInEx/patchers, enabled), SPT's own left out. */
export function serverPatchers(snapshot: ServerPatcherSource): RemoteMod[] {
  return (snapshot.clientMods ?? []).filter((m) => m.area === "patchers" && m.enabled && !isSptOwnPatcher(m.id));
}

/**
 * The server's prepatchers that belong with these plugins, by that machine's install record first
 * and by name otherwise. Nothing is attributed by guesswork beyond the name rule the local install
 * already applies — an entry nobody can be shown to own is not pulled with a plugin.
 */
export function serverPatchersOwnedBy(pluginIds: string[], snapshot: ServerPatcherSource): RemoteMod[] {
  const patchers = serverPatchers(snapshot);
  if (patchers.length === 0 || pluginIds.length === 0) return [];
  const plugins = (snapshot.clientMods ?? []).filter((m) => (m.area ?? "plugins") === "plugins").map((m) => m.id);
  const attribution = attributePatchersFromLedgers(
    snapshot.remoteLedgers?.registry ?? [],
    snapshot.remoteLedgers?.installManifest ?? {},
    plugins,
    patchers.map((p) => p.id)
  );
  const wanted = new Set(pluginIds.map((id) => id.toLowerCase()));
  return patchers.filter((p) => {
    const owner = attribution.byEntry[p.id.toLowerCase()];
    return owner?.kind === "mod" && owner.mods.some((m) => wanted.has(m.toLowerCase()));
  });
}

export interface PrepatcherPullResult {
  /** Entries written into BepInEx/patchers, in the order they were pulled. */
  pulled: string[];
  failed: { entry: string; message: string }[];
  /** References of the pulled prepatchers that still resolve nowhere on this install. */
  unresolved: { patcher: string; reference: string }[];
}

/**
 * Pulls `start`, then whatever those reference that this install cannot resolve and one of the
 * server's prepatchers provides, until nothing more is needed (bounded, in case of a cycle).
 */
export async function pullPrepatchersFromServer(
  origin: string,
  localClientRoot: string,
  available: RemoteMod[],
  start: RemoteMod[],
  options: ServerPullOptions = {}
): Promise<PrepatcherPullResult> {
  const target = path.join(localClientRoot, "BepInEx", "patchers");
  const pulled: string[] = [];
  const failed: PrepatcherPullResult["failed"] = [];
  const tried = new Set<string>();

  const pull = async (p: RemoteMod) => {
    const key = p.id.toLowerCase();
    if (tried.has(key) || isSptOwnPatcher(p.id)) return;
    tried.add(key);
    const r = await installModFromServer(origin, "patchers", p.id, target, {
      ...options,
      entry: { kind: p.kind, sizeBytes: p.sizeBytes }
    });
    if (r.success) pulled.push(p.id);
    else failed.push({ entry: p.id, message: r.message });
  };

  for (const p of start) await pull(p);

  // Which server entry provides an assembly: by its own name first (MoreBotsPrepatch/ provides
  // MoreBotsPrepatch), then by a DLL of that name inside a folder entry, asked for only when needed.
  const listings = new Map<string, string[]>();
  const provides = async (p: RemoteMod, reference: string): Promise<boolean> => {
    const ref = reference.toLowerCase();
    if (p.id.replace(/\.dll$/i, "").toLowerCase() === ref) return true;
    if (p.kind === "file") return false;
    if (!listings.has(p.id)) {
      const l = await listServerModFiles(origin, "patchers", p.id, options);
      listings.set(p.id, l.error ? [] : l.files.map((f) => path.posix.basename(f.path).toLowerCase()));
    }
    return listings.get(p.id)!.includes(`${ref}.dll`);
  };

  const unresolvedOfPulled = () => {
    const mine = new Set(pulled.map((e) => e.toLowerCase()));
    return checkPatcherReferences(localClientRoot).files.filter((f) => mine.has(f.entry.toLowerCase()));
  };

  for (let round = 0; round < 10; round++) {
    const needed = new Set<string>();
    for (const f of unresolvedOfPulled()) for (const ref of f.unresolved ?? []) needed.add(ref);
    let progressed = false;
    for (const ref of needed) {
      for (const p of available) {
        if (tried.has(p.id.toLowerCase())) continue;
        if (await provides(p, ref)) {
          await pull(p);
          progressed = true;
          break;
        }
      }
    }
    if (!progressed) break;
  }

  const unresolved = unresolvedOfPulled().flatMap((f) => (f.unresolved ?? []).map((reference) => ({ patcher: f.relPath, reference })));
  return { pulled, failed, unresolved };
}
