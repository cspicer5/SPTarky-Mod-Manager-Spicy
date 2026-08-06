/**
 * Harvests the SPT Forge ADDON catalogue into a local file.
 *
 * WHY THIS EXISTS AND WHY IT IS URGENT
 * ------------------------------------
 * Forge shuts down on 2026-08-10. Addons are a first-class Forge entity with their own
 * `/addon/` namespace, and they are the only place a mod-to-mod COMPATIBILITY relationship is
 * written down anywhere machine-readable:
 *
 *   - `mod_id`                 the parent mod this addon attaches to
 *   - `mod_version_constraint` which versions of that parent it works with
 *
 * Nothing else has this. The mods themselves do not declare it (0 of 27 server mods on the
 * reference install declare any dependency), and the mod API has no dependency field at all —
 * checked directly against `/mod/<id>` and its versions on 2026-08-06. So once the API is
 * gone, "which patch makes these two mods work together" cannot be rebuilt at any cost.
 *
 * 78 addons across 39 parent mods at the time of writing — small, quick, and irreplaceable.
 *
 * Usage:
 *   node scripts/harvest-forge-addons.js
 *   node scripts/harvest-forge-addons.js --out data/forge-addons.json
 *
 * Resumable in the same way as the mod harvest: progress is written after every page.
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = path.resolve(outArg !== -1 ? args[outArg + 1] : path.join(__dirname, "..", "data", "forge-addons.json"));

const API = "https://forge.sp-tarkov.com/api/v0";
// Documented limits are 40 req/10s burst and 200/60s sustained. Probing harder than that
// during development earned a Cloudflare 403 for the whole IP, not merely a 429.
const REQUEST_INTERVAL_MS = 600;
const FORGE_SHUTDOWN = "2026-08-10";

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
function condense(a) {
  const versions = Array.isArray(a.versions) ? a.versions : [];
  return {
    id: a.id,
    name: a.name,
    slug: a.slug,
    teaser: a.teaser ?? undefined,
    owner: a.owner?.name ?? undefined,
    downloads: a.downloads ?? undefined,
    detailUrl: a.detail_url ?? undefined,
    // The whole reason this file exists: which mod this addon attaches to.
    modId: a.mod_id ?? undefined,
    // An addon whose parent was removed from Forge. Kept rather than dropped — it still
    // documents a relationship, and after the shutdown nothing can re-check it.
    isDetached: a.is_detached === true ? true : undefined,
    publishedAt: a.published_at ?? undefined,
    updatedAt: a.updated_at ?? undefined,
    // Every version, not just the latest. An addon is pinned to a RANGE of parent versions,
    // so the newest addon build is not necessarily the one that fits the parent you have —
    // the same lesson the SPT version picker learned about mods.
    versions: versions.map((v) => ({
      version: v.version,
      link: v.link,
      bytes: v.content_length ?? undefined,
      // Semver range against the PARENT mod's version, e.g. "~1.0.0".
      modConstraint: v.mod_version_constraint || undefined,
      publishedAt: v.published_at ?? undefined
    }))
  };
}

function load() {
  if (!fs.existsSync(OUT)) return { addons: {} };
  try {
    const prior = JSON.parse(fs.readFileSync(OUT, "utf-8"));
    const addons = {};
    for (const a of prior.addons ?? []) addons[a.id] = a;
    return { addons };
  } catch {
    return { addons: {} };
  }
}

function save(state, meta) {
  const list = Object.values(state.addons).sort((a, b) => a.id - b.id);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        harvestedAt: new Date().toISOString(),
        forgeShutdownDate: FORGE_SHUTDOWN,
        source: "https://forge.sp-tarkov.com/api/v0/addons?include=versions",
        note:
          "Forge addons are compatibility/companion mods. modId is the parent mod; " +
          "versions[].modConstraint is the range of PARENT versions each addon build fits.",
        count: list.length,
        ...meta,
        addons: list
      },
      null,
      2
    ),
    "utf-8"
  );
}

(async () => {
  console.log("=".repeat(72));
  console.log("FORGE ADDON HARVEST");
  console.log("=".repeat(72));
  console.log(`out : ${OUT}`);

  const state = load();
  const had = Object.keys(state.addons).length;
  if (had) console.log(`resuming with ${had} addon(s) already captured`);

  let page = 1;
  let lastPage = 1;
  let fetched = 0;

  while (page <= lastPage) {
    const body = await getJson(`${API}/addons?include=versions&page=${page}`);
    const data = body?.data ?? [];
    lastPage = body?.meta?.last_page ?? page;

    for (const a of data) {
      if (a?.id === undefined) continue;
      state.addons[a.id] = condense(a);
      fetched++;
    }
    save(state, {});
    console.log(`  page ${page}/${lastPage} — ${data.length} addon(s), ${Object.keys(state.addons).length} total`);
    page++;
  }

  // The list endpoint omits `description`; only the detail endpoint has it. Worth one request
  // each at this size, because after the shutdown a teaser alone may not say what a patch
  // actually patches.
  const list = Object.values(state.addons);
  console.log(`\nfetching descriptions for ${list.length} addon(s)...`);
  let described = 0;
  for (const a of list) {
    if (a.description !== undefined) continue;
    try {
      const body = await getJson(`${API}/addon/${a.id}`);
      const d = body?.data ?? body;
      a.description = typeof d?.description === "string" ? d.description : "";
      described++;
      if (described % 10 === 0) {
        process.stdout.write(`  ${described}/${list.length}\r`);
        save(state, {});
      }
    } catch (err) {
      console.log(`  !! addon ${a.id} description failed: ${err.message}`);
    }
  }
  process.stdout.write(" ".repeat(40) + "\r");

  const final = Object.values(state.addons);
  const parents = new Set(final.map((a) => a.modId).filter(Boolean));
  const withVersions = final.filter((a) => a.versions.length > 0);
  const withLink = final.filter((a) => a.versions.some((v) => v.link));
  const withConstraint = final.filter((a) => a.versions.some((v) => v.modConstraint));

  save(state, {
    parentModCount: parents.size,
    withDownloadableVersion: withLink.length
  });

  console.log("-".repeat(72));
  console.log("SUMMARY");
  console.log("-".repeat(72));
  console.log(`  addons captured        : ${final.length}  (${fetched} fetched this run)`);
  console.log(`  distinct parent mods   : ${parents.size}`);
  console.log(`  with >=1 version       : ${withVersions.length}`);
  console.log(`  with a download link   : ${withLink.length}`);
  console.log(`  with a parent constraint: ${withConstraint.length}`);
  console.log(`  detached from parent   : ${final.filter((a) => a.isDetached).length}`);
  console.log(`  total versions         : ${final.reduce((s, a) => s + a.versions.length, 0)}`);
  console.log(`  file size              : ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
  console.log(`\n  written to ${OUT}`);
})().catch((err) => {
  console.error("\nHARVEST FAILED:", err.message);
  console.error("Progress was saved; re-run to resume.");
  process.exit(1);
});
