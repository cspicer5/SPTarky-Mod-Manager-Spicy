/**
 * Mod dependencies — what a mod needs, and whether you have it (v1.3.2).
 *
 * The catalogue exposes `/mods/dependencies?mods=<id>:<version>,...&spt_version=<v>`, which
 * is purpose-built for this: batched, SPT-version-aware, and it answers with the dependency's
 * numeric id, guid, and the newest build COMPATIBLE WITH THE SPT VERSION ASKED FOR, download
 * link included. That last part is what makes a missing dependency actionable rather than
 * merely reported.
 *
 * ## What the endpoint actually does, measured before this was written
 *
 * - `spt_version` is REQUIRED. Without it the call is a 400, not a default.
 * - It is genuinely version-aware. SAIN 4.4.3 asked about SPT 4.0.13 answers BigBrain 1.4.0;
 *   the same query at 4.1.2 answers BigBrain with `latest_compatible_version: null`. That is
 *   a THIRD state — the dependency exists and has no build for your SPT — and it must not be
 *   reported as "missing", because installing it is not the fix.
 * - Dependencies nest: MoreBotsAPI carries BigBrain, WTT Content Backport carries CommonLib.
 * - **Dependencies can form CYCLES.** Painter requires Tactical Gear Component and Tactical
 *   Gear Component requires Painter. Any walk of the graph has to carry a seen-set or it will
 *   not terminate.
 * - An unknown mod id, or a version that does not exist, returns HTTP 200 with the key simply
 *   ABSENT from `data` — indistinguishable from "this mod has no dependencies" unless key
 *   presence is checked. `unknown` exists to keep those apart.
 * - Response keys are not in request order, so results are matched by `id:version` and never
 *   by position.
 *
 * Coverage is partial and that is worth stating plainly: 12 of the 50 most-downloaded mods
 * declare anything at all. Silence from the catalogue is not evidence that a mod is
 * self-contained — the assembly scrape in addons.ts sees relationships this does not (SAIN
 * declares nothing on older versions yet its plugin references BigBrain directly).
 */
import { getRegistryApiBase } from "./registry";

/** One entry as the catalogue returns it. */
export interface RawDependency {
  id: number;
  guid?: string | null;
  name: string;
  slug?: string | null;
  conflict?: boolean;
  latest_compatible_version?: {
    id?: number;
    version?: string;
    link?: string;
    content_length?: number | null;
  } | null;
  dependencies?: RawDependency[];
}

/**
 * Whether you HAVE the dependency. Deliberately independent of `conflict` — see below.
 */
export type DependencyStatus =
  /** Present, and at a version at least as new as the one required. Nothing to do. */
  | "satisfied"
  /** Not installed at all, and a compatible build exists: the actionable one. */
  | "missing"
  /** Installed, but OLDER than the version required. Actionable as an upgrade. */
  | "outdated"
  /** Not installed, and NO build fits this SPT version. Installing cannot fix it. */
  | "no-compatible-build";

export interface DependencyReport {
  modId: number;
  guid?: string;
  name: string;
  slug?: string;
  status: DependencyStatus;
  /**
   * The requested set disagrees about which version of THIS dependency to use.
   *
   * Orthogonal to `status`, and it took a live experiment to establish that. Treating it as
   * a status that outranked "satisfied" labelled WTT - CommonLib unmet for 13 mods on the
   * reference install, when CommonLib was installed and working the whole time.
   */
  conflict: boolean;
  /** What is installed right now, when that is known. */
  installedVersion?: string;
  /** The build the catalogue resolved to — what "needs" means here. */
  version?: string;
  downloadLink?: string;
  bytes?: number;
  /** True when this was reached through another dependency rather than declared directly. */
  transitive: boolean;
  /** The dependency that pulled this one in, for transitive entries. */
  via?: string;
}

export interface DependencyLookup {
  /** Keyed by `<id>:<version>`, exactly as requested. */
  byMod: Map<string, RawDependency[]>;
  /** Requested keys the catalogue did not answer for — NOT the same as "no dependencies". */
  unknown: Set<string>;
  error?: string;
}

/** The catalogue caps a query's length; batching keeps each URL comfortably short. */
const CHUNK = 12;

/**
 * Asks the catalogue what each `<id>:<version>` needs.
 *
 * Never throws: a dependency check is an advisory step attached to installing, and failing
 * the install because the advice could not be fetched would be the worse outcome. A failure
 * surfaces as `error` with everything else empty, and callers report it as "could not check"
 * rather than as "nothing is missing".
 */
export async function fetchDependencies(
  pairs: string[],
  sptVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<DependencyLookup> {
  const byMod = new Map<string, RawDependency[]>();
  const unknown = new Set<string>();
  const wanted = [...new Set(pairs.filter(Boolean))];
  if (wanted.length === 0) return { byMod, unknown };
  if (!sptVersion?.trim()) {
    // Required by the API, and guessing one would silently answer for the wrong SPT.
    return { byMod, unknown: new Set(wanted), error: "No SPT version is set, so dependencies cannot be checked." };
  }

  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const url = new URL(`${getRegistryApiBase()}/mods/dependencies`);
    url.searchParams.set("mods", chunk.join(","));
    url.searchParams.set("spt_version", sptVersion.trim());
    try {
      const res = await fetchImpl(url.toString(), { headers: { Accept: "application/json" } });
      if (!res.ok) {
        for (const key of chunk) unknown.add(key);
        continue;
      }
      const json: any = await res.json();
      const data = json?.data;
      if (!data || typeof data !== "object") {
        for (const key of chunk) unknown.add(key);
        continue;
      }
      for (const key of chunk) {
        // Key presence is the whole test: an absent key means the catalogue had no answer,
        // while a present empty array means "this mod needs nothing".
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          byMod.set(key, Array.isArray(data[key]) ? data[key] : []);
        } else {
          unknown.add(key);
        }
      }
    } catch {
      for (const key of chunk) unknown.add(key);
    }
  }
  return { byMod, unknown };
}

/**
 * What is installed, and at which version.
 *
 * Versions matter, not just presence: a dependency is only worth raising when the mod needs
 * something NEWER than what is already there. Reporting every declared dependency you happen
 * to own would have flagged WTT - CommonLib on thirteen mods of the reference install, all of
 * them already satisfied by a newer build than the one the catalogue resolved to.
 *
 * A value of `undefined` means "installed, version unknown" — which is treated as satisfied,
 * because guessing that an unreadable version is too old is how a checker starts crying wolf.
 */
export interface InstalledIndex {
  /** Lowercased guid -> installed version (undefined when the version could not be read). */
  byGuid: Map<string, string | undefined>;
  /** Catalogue id -> installed version, from the match cache. */
  byCatalogueId: Map<number, string | undefined>;
}

/** Numeric comparison; tolerates a leading "v" and any number of parts. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    String(v)
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** `{ found }` plus the installed version when one is known. */
function locate(dep: RawDependency, installed: InstalledIndex): { found: boolean; version?: string } {
  const guid = dep.guid ? String(dep.guid).toLowerCase() : "";
  if (guid && installed.byGuid.has(guid)) return { found: true, version: installed.byGuid.get(guid) };
  const id = Number(dep.id);
  if (installed.byCatalogueId.has(id)) return { found: true, version: installed.byCatalogueId.get(id) };
  return { found: false };
}

/**
 * Flattens a dependency tree into a report, one entry per distinct mod.
 *
 * Cycle-safe by construction: Painter and Tactical Gear Component each declare the other, so
 * a naive recursion never returns. Each mod id is visited once, and the FIRST route to it
 * wins — a directly declared dependency therefore outranks the same mod reached transitively,
 * which is what should be shown.
 */
export function flattenDependencies(
  roots: RawDependency[],
  installed: InstalledIndex,
  via?: string
): DependencyReport[] {
  const out: DependencyReport[] = [];
  const seen = new Set<number>();

  const walk = (list: RawDependency[], transitive: boolean, parent?: string) => {
    for (const dep of list ?? []) {
      const id = Number(dep?.id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);

      const build = dep.latest_compatible_version;
      const here = locate(dep, installed);

      /*
       * Only raise a dependency when the mod needs something NEWER than what is present.
       *
       * `latest_compatible_version` is the catalogue's own resolution for the SPT version
       * asked about, and it is the only version figure the endpoint exposes — no raw
       * constraint is returned. So "needs" means that build, and anything at least as new
       * satisfies it.
       *
       * This is what keeps the check quiet enough to be worth reading. On the reference
       * install WTT - CommonLib resolves to 2.0.5 for one mod and 2.0.23 for another, while
       * 2.0.23 is installed: newer than both, so neither is worth mentioning.
       *
       * THE UPGRADE TARGET IS BOUNDED ABOVE BY SPT, and that is the important half. The
       * endpoint resolves against the `spt_version` it was given, so the build named here is
       * by construction the newest one that RUNS on this install — never simply the newest
       * one published. BigBrain 1.5.0 targets SPT ~4.1.0; asked about 4.0.13 the answer is
       * 1.4.0. So "upgrade to this" can never push someone onto a build their SPT cannot
       * load, which is the trap an unbounded "just get the latest" check would walk into.
       *
       * The corollary: when there IS no build for this SPT, `latest_compatible_version` is
       * null. Installed-and-null is left as satisfied rather than flagged — whatever is
       * there is running, and the catalogue has nothing to offer that would improve it.
       */
      let status: DependencyStatus;
      if (!here.found) {
        status = build?.link ? "missing" : "no-compatible-build";
      } else if (here.version && build?.version && compareVersions(here.version, build.version) < 0) {
        status = "outdated";
      } else {
        // Installed and new enough — or installed with a version nobody can read, which is
        // not evidence of being out of date.
        status = "satisfied";
      }

      out.push({
        modId: id,
        guid: dep.guid ?? undefined,
        name: dep.name,
        slug: dep.slug ?? undefined,
        status,
        conflict: dep.conflict === true,
        installedVersion: here.version,
        version: build?.version,
        downloadLink: build?.link,
        bytes: build?.content_length ?? undefined,
        transitive,
        via: transitive ? parent : via
      });

      if (Array.isArray(dep.dependencies) && dep.dependencies.length) {
        walk(dep.dependencies, true, dep.name);
      }
    }
  };

  walk(roots, false);
  return out;
}

export interface DependencyCheck {
  reports: DependencyReport[];
  missing: DependencyReport[];
  /** Present but older than required — an upgrade, not an install. */
  outdated: DependencyReport[];
  unavailable: DependencyReport[];
  conflicts: DependencyReport[];
  /** True when the catalogue had no answer for the mod asked about. */
  unknown: boolean;
  error?: string;
}

/** Everything for one installed/installing mod, split into the buckets the UI shows. */
export async function checkModDependencies(
  modId: number,
  version: string,
  sptVersion: string,
  installed: InstalledIndex,
  fetchImpl: typeof fetch = fetch
): Promise<DependencyCheck> {
  const key = `${modId}:${version}`;
  const lookup = await fetchDependencies([key], sptVersion, fetchImpl);
  const raw = lookup.byMod.get(key);
  const reports = raw ? flattenDependencies(raw, installed) : [];
  return {
    reports,
    missing: reports.filter((r) => r.status === "missing"),
    outdated: reports.filter((r) => r.status === "outdated"),
    unavailable: reports.filter((r) => r.status === "no-compatible-build"),
    conflicts: reports.filter((r) => r.conflict),
    unknown: lookup.unknown.has(key),
    error: lookup.error
  };
}

/**
 * One line describing the outcome, so the caller does not have to assemble it.
 *
 * Deliberately distinguishes "could not check" from "nothing missing". Reporting an
 * unreachable catalogue as a clean bill of health is the failure this whole module is meant
 * to prevent, and it is the easiest one to write by accident.
 */
export function describeDependencyCheck(check: DependencyCheck, modName: string): string {
  if (check.error) return `Couldn't check what "${modName}" needs: ${check.error}`;
  if (check.unknown) return `The catalogue had no dependency information for "${modName}".`;
  const parts: string[] = [];
  if (check.missing.length) {
    parts.push(`${check.missing.length} missing dependency(ies): ${check.missing.map((m) => m.name).join(", ")}`);
  }
  if (check.unavailable.length) {
    parts.push(
      `${check.unavailable.length} with no build for this SPT version: ${check.unavailable.map((m) => m.name).join(", ")}`
    );
  }
  if (check.conflicts.length) {
    parts.push(`${check.conflicts.length} conflict(s): ${check.conflicts.map((m) => m.name).join(", ")}`);
  }
  if (parts.length === 0) {
    return check.reports.length
      ? `"${modName}" has everything it needs.`
      : `"${modName}" declares no dependencies.`;
  }
  return `"${modName}": ${parts.join("; ")}.`;
}
