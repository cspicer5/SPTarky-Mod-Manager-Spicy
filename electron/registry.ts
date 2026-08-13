/* ==========================================================================
 * Where the mod registry lives.
 *
 * SPT Forge (forge.sp-tarkov.com) shut down on 2026-08-10 and has since been
 * REBUILT at sp-mod.com, which is now the default. forge-alt.katrinfoxvr.com,
 * the successor this app moved to at the shutdown, is still live and is kept
 * as a backup.
 *
 * All three serve the same database: the same numeric mod ids, the same guids,
 * the same /api/v0 surface. That is what makes each move a change of ADDRESS
 * and not a re-match — every id pinned in an install's
 * .spt-mod-manager-forge-match.json still resolves, and the two harvests in
 * data/ stay valid as-is.
 *
 * Checked against both live APIs on 2026-08-09, the day before the shutdown,
 * while a comparison was still possible at all:
 *   - mods 31 / 902 / 2357 are the same mods under the same ids
 *   - 61/61 and 18/18 pinned ids on the two reference installs resolve
 *   - every endpoint this app calls answers 200 with the same shape:
 *     /mods (filter[id], filter[guid], filter[name], filter[slug], query,
 *     filter[category_slug], filter[spt_version], sort), /mods/updates,
 *     /mod/<id>, /mod/<id>/versions, /spt/versions, /mod-categories, /addons
 *
 * THREE differences that matter. Each is handled here or at the call site,
 * and each is silent rather than loud, which is why they are written down:
 *
 *   1. The inline category object keys its label `name`; Forge keyed it
 *      `title`. Read it through readCategoryLabel() and neither can break.
 *      (The standalone /mod-categories endpoint uses `title` on both.)
 *
 *   2. Mod pages are addressed by SLUG: /mods/<slug> answers and /mod/<id> is
 *      a 404, the reverse of Forge. Nothing may build a page URL by pasting an
 *      id into a path — use modPageUrl(), and prefer the API's own detail_url.
 *
 *   3. On the BACKUP host, content_length, additional_authors and the
 *      created_at/updated_at timestamps come back null. Only content_length is
 *      read (the download size in the browse pane), and it already degrades to
 *      "unknown". sp-mod.com populates it, so this is a difference the backup
 *      has and the default does not — worth knowing before blaming the app for
 *      sizes disappearing after a switch.
 *
 * One Forge bug is FIXED here rather than inherited: filter[include_legacy] no
 * longer nullifies the filters it is combined with. The workarounds in
 * modManager are kept anyway — they cost nothing, and they document why the
 * batched id/guid queries are shaped the way they are.
 * ========================================================================== */

/**
 * The catalogue's API root — now the REBUILT Forge at sp-mod.com.
 *
 * Third address for this data and, like the second, a change of ADDRESS rather
 * than a re-match. Verified live on 2026-08-13 before switching, because "it
 * should be the same" is exactly the assumption worth checking:
 *   - SAIN 791, BigBrain 902, WTT-CommonLib 2310 — same ids, same guids
 *   - the same /api/v0 envelope: {success, data, links, meta}
 *   - every endpoint this app calls answers identically on both hosts:
 *     /mods (filter[id], filter[guid], filter[include_legacy]), /mods/updates,
 *     /spt/versions, /mod-categories
 *   - `content_length` is POPULATED here, where the backup returns null — the
 *     browse pane's download size stops being "unknown"
 *   - `detail_url` is absolute and points at sp-mod.com, so page links need no
 *     construction and `getRegistrySiteBase()` derives the right site by
 *     stripping /api/v0
 *
 * `REGISTRY_BACKUP_API_BASE` is the previous successor, still live and still
 * serving the same data. It is not failed over to automatically — a silent
 * switch would make "which catalogue answered this?" unanswerable — but it is
 * named here so the setting has something to paste.
 */
export const DEFAULT_REGISTRY_API_BASE = "https://sp-mod.com/api/v0";

/** The former successor, kept as a backup someone can point the setting at. */
export const REGISTRY_BACKUP_API_BASE = "https://forge-alt.katrinfoxvr.com/api/v0";

/**
 * Rate limit published by the successor: ~300 requests / 60s per client IP,
 * with the health endpoint excluded. That is MORE generous than Forge's
 * 200/60s sustained (and 40/10s burst), which the request pacing in modManager
 * was built around — so that pacing stays correct here without being retuned.
 * A limited request answers 429 with Retry-After, which forgeFetchJson honours.
 */
export const REGISTRY_SUSTAINED_LIMIT_PER_MINUTE = 300;

let overrideApiBase: string | null = null;

/**
 * Normalises whatever someone typed into an API root. Accepts a bare host, a
 * site URL, or a full API URL, because "the address of the site" is what a user
 * has to hand — expecting them to know the /api/v0 suffix would turn a typo
 * into a silent "nothing is ever found".
 */
export function normaliseRegistryApiBase(value: string): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;

  // Whether a scheme is ALREADY present has to be decided before defaulting one in.
  // Prefixing unconditionally turned "ftp://example.org" into "https://ftp://example.org",
  // which parses happily as host `ftp` — a rejected input silently becoming a valid-looking
  // address pointed at the wrong place. Test: "a non-http scheme is rejected".
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Drop any query/fragment someone pasted along with the address.
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  // Already an API root (any version) — keep it. Otherwise append the one we speak.
  const apiPath = /\/api\/v\d+$/i.test(path) ? path : `${path}/api/v0`;
  return `${url.origin}${apiPath}`;
}

/** Applied at startup from the stored setting; null restores the default. */
export function setRegistryApiBase(value: string | null | undefined): void {
  overrideApiBase = value ? normaliseRegistryApiBase(value) : null;
}

export function getRegistryApiBase(): string {
  // The environment variable exists so the contract test can be pointed at a
  // stub, and so a broken default can be worked around without a rebuild.
  const fromEnv = process.env.SPTARKY_REGISTRY_API;
  return overrideApiBase || (fromEnv && normaliseRegistryApiBase(fromEnv)) || DEFAULT_REGISTRY_API_BASE;
}

/** The website behind the API — the API root minus its /api/vN suffix. */
export function getRegistrySiteBase(): string {
  return getRegistryApiBase().replace(/\/api\/v\d+$/i, "");
}

/** Host shown in tooltips, so the UI names the site it is actually querying. */
export function getRegistryHost(): string {
  try {
    return new URL(getRegistryApiBase()).host;
  } catch {
    return "";
  }
}

/**
 * A mod's page on the site.
 *
 * `detailUrl` is the API's own answer and always wins: it is correct by
 * construction, including for any future address change. The slug form is the
 * fallback. An id CANNOT be used — /mod/<id> is a 404 on the successor — so a
 * mod known only by id gets no link rather than a broken one.
 */
export function modPageUrl(ref: { detailUrl?: string | null; slug?: string | null }): string | undefined {
  if (ref.detailUrl && /^https?:\/\//i.test(ref.detailUrl)) return ref.detailUrl;
  if (ref.slug) return `${getRegistrySiteBase()}/mods/${encodeURIComponent(ref.slug)}`;
  return undefined;
}

/** An addon's page. Same rule as modPageUrl: /addon/<id> is a 404. */
export function addonPageUrl(ref: { detailUrl?: string | null; slug?: string | null }): string | undefined {
  if (ref.detailUrl && /^https?:\/\//i.test(ref.detailUrl)) return ref.detailUrl;
  if (ref.slug) return `${getRegistrySiteBase()}/addons/${encodeURIComponent(ref.slug)}`;
  return undefined;
}

/**
 * The label of an inline category object.
 *
 * The successor keys it `name`, Forge keyed it `title`, and reading only one of
 * them yields undefined against the other — indistinguishable from a mod with
 * no category, which is exactly how this went unnoticed. It was live in the
 * browse pane: the app read `.name`, Forge sent `title`, and every mod showed a
 * blank category. Reading both is the fix and the guard.
 */
export function readCategoryLabel(category: any): string | undefined {
  if (!category || typeof category !== "object") return undefined;
  const label = category.title ?? category.name;
  return typeof label === "string" && label.trim() ? label : undefined;
}

/**
 * True for a mod or addon page on the configured catalogue.
 *
 * This is the allowlist behind "open this in a browser", so it is security-relevant: the URL
 * arrives from the renderer, which is not trusted to tell the OS to open arbitrary things.
 *
 * Compared by parsed ORIGIN, never by prefix match. "Starts with the site URL" would also
 * accept https://evil.example/?x=https://the-site/ and https://the-site.evil.example/ —
 * exactly the shapes an allowlist exists to stop. https only, since that is what the
 * catalogue serves.
 */
export function isRegistryPageUrl(url: string): boolean {
  let parsed: URL;
  let site: URL;
  try {
    parsed = new URL(url);
    site = new URL(getRegistrySiteBase());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.origin !== site.origin) return false;
  // /mods/<slug> and /addons/<slug> are the page forms. /mod/<id> is the older Forge one,
  // kept readable so a link made before the move still opens.
  return /^\/(mods|addons)\/[^/]+/.test(parsed.pathname) || /^\/mod\/\d+/.test(parsed.pathname);
}

/**
 * What a pasted mod reference points at.
 *
 * Someone relinking a mod by hand pastes whatever the browser gave them. That
 * is now a slug URL, but old Forge links and bare ids still turn up in guides,
 * bookmarks and chat logs, so all three stay readable. A slug needs a lookup to
 * become an id; an id is usable directly.
 */
export type ModRef = { kind: "id"; id: number } | { kind: "slug"; slug: string };

export function parseModRef(input: string): ModRef | null {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;

  // A bare numeric id.
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    return id > 0 ? { kind: "id", id } : null;
  }

  // Anything URL-shaped, from any host: what identifies the mod is the path.
  // Matching on the path rather than on a known host means a link from a mirror,
  // a future address, or a copy behind a proxy still reads correctly.
  let pathname = trimmed;
  try {
    pathname = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).pathname;
  } catch {
    return null;
  }

  // Forge's form: /mod/<id> optionally followed by a slug.
  const byId = /\/mod\/(\d+)(?:\/|$)/i.exec(pathname);
  if (byId) {
    const id = Number(byId[1]);
    if (id > 0) return { kind: "id", id };
  }

  // The successor's form: /mods/<slug>. Note the plural — /mod/ is the id form
  // above, and confusing the two is the whole reason this is parsed centrally.
  const bySlug = /\/mods\/([^/?#]+)/i.exec(pathname);
  if (bySlug) {
    const slug = decodeURIComponent(bySlug[1]).trim();
    // A slug that is entirely digits would be ambiguous; treat it as an id.
    if (/^\d+$/.test(slug)) return { kind: "id", id: Number(slug) };
    if (slug) return { kind: "slug", slug };
  }

  return null;
}
