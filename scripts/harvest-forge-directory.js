/**
 * Harvests the full SPT Forge catalogue into a local directory file.
 *
 * WHY THIS EXISTS AND WHY IT IS URGENT
 * ------------------------------------
 * SPT Forge shuts down on 2026-08-12. The mapping from a mod's identity (GUID / Forge id)
 * to its source repository exists ONLY in the Forge API. Once the API is gone, that
 * mapping cannot be rebuilt at any cost.
 *
 * This captures it while it is still available, so update checking can move to GitHub
 * releases afterwards. See docs/FORGE-SHUTDOWN.md.
 *
 * No scraping and no authentication: the API returns source links directly via
 * `include=source_code_links`. Measured coverage across a 400-mod sample was 92% with a
 * source link, 97.6% of those on GitHub.
 *
 * Usage:
 *   node scripts/harvest-forge-directory.js
 *   node scripts/harvest-forge-directory.js --out data/forge-directory.json
 *
 * The run is resumable. Progress is written after every page, so an interrupted or
 * rate-limited run can be restarted and will skip what it already has. That matters more
 * than it normally would: there is no second chance to collect this after the shutdown.
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = path.resolve(outArg !== -1 ? args[outArg + 1] : path.join(__dirname, "..", "data", "forge-directory.json"));

const API = "https://forge.sp-tarkov.com/api/v0";
const PER_PAGE = 50; // the API caps here regardless of what is requested
// Documented limits are 40 req/10s burst and 200/60s sustained. Probing harder than that
// during development earned a Cloudflare 403 for the whole IP, not merely a 429 - so this
// stays deliberately well under the burst limit.
const REQUEST_INTERVAL_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function getJson(url, attempt = 0) {
  const since = Date.now() - lastRequestAt;
  if (since < REQUEST_INTERVAL_MS) await sleep(REQUEST_INTERVAL_MS - since);
  lastRequestAt = Date.now();

  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SPTarky-Mod-Manager-Harvest" } });
  } catch (err) {
    if (attempt >= 4) throw err;
    const wait = 2000 * (attempt + 1);
    console.log(`    network error, retrying in ${wait / 1000}s...`);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }

  if (res.status === 429 || res.status === 403) {
    if (attempt >= 5) throw new Error(`rate limited repeatedly (HTTP ${res.status}) - resume later`);
    const retryAfter = Number(res.headers.get("retry-after") || 0);
    const wait = Math.min(Math.max(retryAfter, 10), 120) * 1000;
    console.log(`    HTTP ${res.status}; backing off ${wait / 1000}s (attempt ${attempt + 1})`);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Keeps only what is durable and useful after the shutdown. */
function condense(m) {
  const links = Array.isArray(m.source_code_links) ? m.source_code_links : [];
  const normalised = links
    .map((l) => (typeof l === "string" ? { url: l } : l))
    .filter((l) => l && typeof l.url === "string");
  const github = normalised.find((l) => {
    try {
      return new URL(l.url).hostname.replace(/^www\./, "").endsWith("github.com");
    } catch {
      return false;
    }
  });

  // Only the newest version is kept. Older entries are mostly download URLs that stop
  // resolving once Forge is down, so storing them would bloat the file for no benefit.
  const versions = Array.isArray(m.versions) ? m.versions : [];
  const latest = versions[0];

  return {
    id: m.id,
    hubId: m.hub_id ?? undefined,
    guid: m.guid ?? undefined,
    name: m.name,
    slug: m.slug,
    owner: m.owner?.name ?? undefined,
    category: m.category?.name ?? undefined,
    downloads: m.downloads ?? 0,
    detailUrl: m.detail_url ?? undefined,
    sourceUrl: github?.url ?? normalised[0]?.url ?? undefined,
    sourceIsGithub: !!github,
    sourceLinks: normalised.length > 1 ? normalised.map((l) => l.url) : undefined,
    latestVersion: latest?.version ?? undefined,
    latestSptConstraint: latest?.spt_version_constraint ?? undefined,
    updatedAt: m.updated_at ?? undefined
  };
}

function load() {
  if (!fs.existsSync(OUT)) return { mods: {}, pagesDone: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT, "utf-8"));
    const mods = {};
    for (const m of parsed.mods ?? []) mods[m.id] = m;
    return { mods, pagesDone: parsed._resume?.pagesDone ?? {} };
  } catch {
    return { mods: {}, pagesDone: {} };
  }
}

function save(mods, pagesDone, complete) {
  const list = Object.values(mods).sort((a, b) => a.id - b.id);
  const withSource = list.filter((m) => m.sourceUrl).length;
  const withGithub = list.filter((m) => m.sourceIsGithub).length;
  const payload = {
    harvestedFrom: API,
    // Stamped so a future reader knows how stale this is, and that it predates the
    // shutdown rather than being a partial post-mortem capture.
    harvestedAt: new Date().toISOString(),
    forgeShutdownDate: "2026-08-12",
    complete,
    counts: { total: list.length, withSource, withGithub },
    mods: list,
    _resume: complete ? undefined : { pagesDone }
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf-8");
}

async function harvestPass(label, includeLegacy, state) {
  // sort=created_at, not id: the API rejects sorting by id with HTTP 400. A stable sort
  // matters because pagination is offset-based, and an unstable order would let mods shift
  // between pages and be missed. Verified that include= still applies when
  // filter[include_legacy] is present (unlike the other filters, which it silently voids).
  const base =
    `${API}/mods?per_page=${PER_PAGE}&include=source_code_links,versions&sort=created_at` +
    (includeLegacy ? "&filter[include_legacy]=true" : "");

  const first = await getJson(`${base}&page=1`);
  const lastPage = first.meta?.last_page ?? 1;
  const total = first.meta?.total ?? 0;
  console.log(`  ${label}: ${total} mods across ${lastPage} pages`);

  const absorb = (json) => {
    for (const m of json.data ?? []) {
      const c = condense(m);
      // Merge rather than overwrite: the legacy pass can return a mod the first pass
      // already covered, and either response may be the one carrying the source link.
      const existing = state.mods[c.id];
      state.mods[c.id] = existing ? { ...existing, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) } : c;
    }
  };

  absorb(first);
  state.pagesDone[`${label}:1`] = true;
  save(state.mods, state.pagesDone, false);

  for (let page = 2; page <= lastPage; page++) {
    if (state.pagesDone[`${label}:${page}`]) continue;
    const json = await getJson(`${base}&page=${page}`);
    absorb(json);
    state.pagesDone[`${label}:${page}`] = true;
    save(state.mods, state.pagesDone, false);
    const done = Object.keys(state.mods).length;
    process.stdout.write(`    page ${page}/${lastPage}  (${done} mods collected)\r`);
  }
  process.stdout.write(" ".repeat(60) + "\r");
}

(async () => {
  console.log("=".repeat(72));
  console.log("SPT FORGE DIRECTORY HARVEST");
  console.log("=".repeat(72));
  console.log(`output : ${OUT}`);

  const state = load();
  const resumed = Object.keys(state.mods).length;
  if (resumed) console.log(`resuming: ${resumed} mods already collected`);
  console.log("");

  try {
    // Two passes. include_legacy surfaces mods with no SPT version constraint, which the
    // default listing hides - and those are exactly the old mods most at risk of being
    // lost entirely once Forge is gone.
    await harvestPass("main", false, state);
    await harvestPass("legacy", true, state);
  } catch (err) {
    save(state.mods, state.pagesDone, false);
    console.error(`\nHARVEST INTERRUPTED: ${err.message}`);
    console.error("Progress was saved. Re-run to resume from where it stopped.");
    process.exit(1);
  }

  save(state.mods, state.pagesDone, true);

  const list = Object.values(state.mods);
  const withSource = list.filter((m) => m.sourceUrl).length;
  const withGithub = list.filter((m) => m.sourceIsGithub).length;
  const withGuid = list.filter((m) => m.guid).length;

  console.log("-".repeat(72));
  console.log("SUMMARY");
  console.log("-".repeat(72));
  console.log(`  mods captured     : ${list.length}`);
  console.log(`  with a GUID       : ${withGuid}  (${((100 * withGuid) / list.length).toFixed(1)}%)`);
  console.log(`  with a source URL : ${withSource}  (${((100 * withSource) / list.length).toFixed(1)}%)`);
  console.log(`  of those, GitHub  : ${withGithub}  (${((100 * withGithub) / Math.max(withSource, 1)).toFixed(1)}%)`);
  console.log(`  file size         : ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
  console.log("");
  console.log("  COMMIT THIS FILE. It cannot be regenerated after 2026-08-12.");
  console.log("");
})();
