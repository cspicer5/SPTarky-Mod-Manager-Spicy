/**
 * Where each installed mod's code lives.
 *
 * This is the bridge to a world without Forge. Once the API is gone the app can no longer
 * ask "is there a newer version of this?" — unless it already knows the repository. GitHub
 * has a releases API that needs no authentication, so a recorded source URL turns an
 * unanswerable question back into an answerable one.
 *
 * Three sources, strongest first:
 *   1. what Forge returned at install time (recorded in the registry);
 *   2. the pre-shutdown harvest in data/forge-directory.json, matched through the Forge id
 *      the app already resolved for each mod;
 *   3. a live SPT server, which reports a `Url` for many of its loaded server mods.
 *
 * (2) is why this does not depend on reinstalling anything: the harvest plus the existing
 * match cache covers every mod the app has ever identified. Measured on the reference
 * install: 57 of 57 resolved mods, all GitHub.
 */
import fs from "fs";
import path from "path";

export interface ModSource {
  url: string;
  isGithub: boolean;
  /** owner/repo, when the URL is a GitHub repository — what the releases API needs. */
  repo?: string;
  /** Where this came from, so a weak answer is visible as one. */
  origin: "forge-install" | "harvest" | "server";
}

/** Extracts "owner/repo" from a GitHub URL, ignoring trailing paths, .git and query strings. */
export function githubRepoFromUrl(url: string): string | undefined {
  try {
    // People paste "github.com/owner/repo" as often as the full URL, and new URL() rejects
    // it outright, so a scheme is added when one is missing.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    const parsed = new URL(withScheme);
    if (!parsed.hostname.replace(/^www\./, "").endsWith("github.com")) return undefined;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (!owner || !repo) return undefined;
    return `${owner}/${repo}`;
  } catch {
    return undefined;
  }
}

interface HarvestMod {
  id: number;
  name?: string;
  guid?: string;
  sourceUrl?: string;
  sourceIsGithub?: boolean;
  sourceLinks?: string[];
}

let harvestCache: { byId: Map<string, HarvestMod>; byGuid: Map<string, HarvestMod> } | null = null;

/**
 * The harvested Forge directory, indexed. Loaded lazily and kept — it is ~1.4 MB of JSON and
 * re-parsing it per mod would dominate a scan.
 */
export function loadHarvest(): { byId: Map<string, HarvestMod>; byGuid: Map<string, HarvestMod> } {
  if (harvestCache) return harvestCache;
  const candidates = [
    path.join(__dirname, "..", "data", "forge-directory.json"),
    path.join(process.cwd(), "data", "forge-directory.json")
  ];
  const byId = new Map<string, HarvestMod>();
  const byGuid = new Map<string, HarvestMod>();
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as { mods?: HarvestMod[] };
      for (const mod of parsed.mods ?? []) {
        byId.set(String(mod.id), mod);
        if (mod.guid) byGuid.set(mod.guid.trim().toLowerCase(), mod);
      }
      break;
    } catch {
      /* fall through */
    }
  }
  harvestCache = { byId, byGuid };
  return harvestCache;
}

function toSource(mod: HarvestMod | undefined, origin: ModSource["origin"]): ModSource | undefined {
  if (!mod?.sourceUrl) return undefined;
  // Prefer a GitHub link when the mod lists several — that is the one with a releases API.
  const links = [mod.sourceUrl, ...(mod.sourceLinks ?? [])];
  const github = links.find((l) => !!githubRepoFromUrl(l));
  const url = github ?? mod.sourceUrl;
  return { url, isGithub: !!github, repo: github ? githubRepoFromUrl(github) : undefined, origin };
}

/** Looks a source up by the Forge id the matcher already resolved, then by GUID. */
export function findSource(forgeId?: string | number, guid?: string): ModSource | undefined {
  const { byId, byGuid } = loadHarvest();
  if (forgeId !== undefined) {
    const hit = toSource(byId.get(String(forgeId)), "harvest");
    if (hit) return hit;
  }
  if (guid) {
    const hit = toSource(byGuid.get(guid.trim().toLowerCase()), "harvest");
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolves a source for every entry in a Forge match cache.
 *
 * Keyed by the same folder names the cache uses, so callers can attach the result to the
 * registry without another round of matching.
 */
export function resolveSourcesFromMatchCache(
  matchCache: Record<string, { modId: string }>
): Record<string, ModSource> {
  const out: Record<string, ModSource> = {};
  for (const [folder, entry] of Object.entries(matchCache)) {
    const source = findSource(entry?.modId);
    if (source) out[folder] = source;
  }
  return out;
}

/**
 * Sources for every mod in an instance, keyed by folder name.
 *
 * Derived rather than stored. The match cache already records which Forge mod each folder
 * is, and the harvest already records where that mod's code lives, so persisting a third
 * copy in the registry would add a migration and a way for the three to disagree. It also
 * means mods installed by hand — which never went through an install path that could have
 * recorded anything — get a source for free.
 */
export function loadInstanceSources(instanceRoot: string): Record<string, ModSource> {
  const cachePath = path.join(instanceRoot, ".spt-mod-manager-forge-match.json");
  let cache: Record<string, { modId: string }> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    cache = raw?.entries ?? raw ?? {};
  } catch {
    return {};
  }
  return resolveSourcesFromMatchCache(cache);
}

/* --------------------------------------------------------------------------
 * Checking GitHub for a newer release
 * ----------------------------------------------------------------------- */

export interface GithubRelease {
  repo: string;
  tag?: string;
  version?: string;
  publishedAt?: string;
  url?: string;
  assetUrl?: string;
  assetName?: string;
  error?: string;
}

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

/**
 * Every release for a repository, newest first, with the installable archives on each.
 *
 * This is the post-Forge equivalent of browsing a mod's version list: paste a repository,
 * pick a release, install it. Releases with no archive attached are kept in the list but
 * cannot be installed — some projects publish source-only releases, and silently hiding them
 * would make the list look wrong against the page the user is reading.
 */
export async function listGithubReleases(
  repoOrUrl: string
): Promise<{ repo?: string; releases: GithubReleaseDetail[]; error?: string }> {
  const repo = githubRepoFromUrl(repoOrUrl) ?? (/^[\w.-]+\/[\w.-]+$/.test(repoOrUrl.trim()) ? repoOrUrl.trim() : undefined);
  if (!repo) return { releases: [], error: "That isn't a GitHub repository URL (expected github.com/owner/repo)." };

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "SPTarky-Mod-Manager" }
    });
    if (res.status === 404) return { repo, releases: [], error: `No such repository, or it is private: ${repo}` };
    if (res.status === 403) {
      return { repo, releases: [], error: "GitHub rate limit reached (60 requests/hour without a token). Try again shortly." };
    }
    if (!res.ok) return { repo, releases: [], error: `GitHub returned HTTP ${res.status}.` };

    const json: any = await res.json();
    if (!Array.isArray(json)) return { repo, releases: [], error: "Unexpected response from GitHub." };

    const releases: GithubReleaseDetail[] = json.map((r: any) => ({
      tag: r.tag_name,
      version: typeof r.tag_name === "string" ? r.tag_name.replace(/^v/i, "") : "",
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      prerelease: !!r.prerelease,
      notes: typeof r.body === "string" ? r.body.slice(0, 2000) : undefined,
      assets: (r.assets ?? [])
        .filter((a: any) => typeof a?.name === "string" && /\.(zip|7z|rar)$/i.test(a.name))
        .map((a: any) => ({ name: a.name, url: a.browser_download_url, size: a.size ?? 0 }))
    }));

    if (releases.length === 0) return { repo, releases, error: `${repo} has no published releases.` };
    return { repo, releases };
  } catch (err: any) {
    return { repo, releases: [], error: err?.message ?? "Couldn't reach GitHub." };
  }
}

/**
 * Latest release for a repository.
 *
 * Unauthenticated GitHub allows 60 requests per hour per IP, which is the binding constraint
 * for a 59-mod install — checking everything twice in an hour exhausts it. Callers are
 * expected to batch and cache; a token raises this to 5,000 and is planned for V2.
 */
export async function fetchLatestGithubRelease(repo: string): Promise<GithubRelease> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "SPTarky-Mod-Manager" }
    });
    if (res.status === 404) return { repo, error: "No releases published." };
    if (res.status === 403) return { repo, error: "GitHub rate limit reached (60/hour without a token)." };
    if (!res.ok) return { repo, error: `GitHub returned HTTP ${res.status}.` };
    const json: any = await res.json();
    const asset = (json.assets ?? []).find((a: any) => typeof a?.name === "string" && /\.(zip|7z|rar)$/i.test(a.name));
    return {
      repo,
      tag: json.tag_name,
      version: typeof json.tag_name === "string" ? json.tag_name.replace(/^v/i, "") : undefined,
      publishedAt: json.published_at,
      url: json.html_url,
      assetUrl: asset?.browser_download_url,
      assetName: asset?.name
    };
  } catch (err: any) {
    return { repo, error: err?.message ?? "Couldn't reach GitHub." };
  }
}
