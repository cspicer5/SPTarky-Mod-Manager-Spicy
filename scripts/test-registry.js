/**
 * The registry contract — where the catalogue lives and how its URLs are read.
 *
 * SPT Forge shut down on 2026-08-10 and the catalogue moved to a successor that mirrors the
 * same database: same numeric ids, same guids, same /api/v0 surface. Every one of these
 * checks guards a difference that is SILENT rather than loud, which is the whole reason they
 * are written down as tests instead of trusted to review:
 *
 *   - the inline category object keys its label `name` here and `title` on Forge. Reading one
 *     of them yields undefined against the other, which is indistinguishable from "this mod
 *     has no category". It was already live: the browse pane read `.name` while Forge sent
 *     `title`, so every mod showed a blank category and nobody noticed.
 *
 *   - mod pages are addressed by SLUG. /mod/<id> is a 404 on the successor and /mods/<slug>
 *     is a 404 on Forge, so anything that builds a page URL from an id produces a dead link
 *     that looks perfectly well-formed.
 *
 *   - the external-link allowlist decides what the app may hand to the OS to open. It used to
 *     hardcode forge.sp-tarkov.com, which meant that after the move NOTHING matched and every
 *     such link became a button that silently did nothing.
 *
 * Pure functions and no network: this pins the PARSING, not the site's availability. A test
 * that needed the catalogue to be up would fail for reasons that are not this code's fault.
 */
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const R = require(path.join(dist, "registry.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("\n=== registry contract ===\n");

/* ---------------------------------------------------------------- base URL */
console.log("normalising an address someone typed");
{
  const N = R.normaliseRegistryApiBase;
  const expected = "https://example.org/api/v0";
  check("bare host gets scheme and api path", N("example.org"), expected);
  check("site URL gets the api path", N("https://example.org"), expected);
  check("trailing slash is dropped", N("https://example.org/"), expected);
  check("an api root is left alone", N("https://example.org/api/v0"), expected);
  check("a different api version is respected", N("https://example.org/api/v3"), "https://example.org/api/v3");
  check("query and fragment are stripped", N("https://example.org/?a=1#x"), expected);
  check("blank is rejected", N("   "), null);
  check("a non-http scheme is rejected", N("ftp://example.org"), null);
  // A path that is not an api root keeps its prefix — some hosts serve under a subpath.
  check("subpath is preserved", N("https://example.org/spt"), "https://example.org/spt/api/v0");
}

console.log("\nswitching the configured base");
{
  const original = R.getRegistryApiBase();
  check("defaults to the built-in address", original, R.DEFAULT_REGISTRY_API_BASE);
  R.setRegistryApiBase("https://mirror.test");
  check("override takes effect", R.getRegistryApiBase(), "https://mirror.test/api/v0");
  check("site base drops the api suffix", R.getRegistrySiteBase(), "https://mirror.test");
  check("host is exposed for tooltips", R.getRegistryHost(), "mirror.test");
  R.setRegistryApiBase(null);
  check("null restores the default", R.getRegistryApiBase(), R.DEFAULT_REGISTRY_API_BASE);
  // The default must itself survive the site/api round trip, or every derived URL is wrong.
  check("default has no trailing slash", R.getRegistrySiteBase().endsWith("/"), false);
}

/* -------------------------------------------------------------- categories */
console.log("\nreading a category label (the key differs between registries)");
{
  const L = R.readCategoryLabel;
  check("successor keys it `name`", L({ id: 1, name: "Traders", slug: "traders" }), "Traders");
  check("Forge keyed it `title`", L({ id: 1, title: "Traders", slug: "traders" }), "Traders");
  check("both present prefers title", L({ title: "A", name: "B" }), "A");
  check("null category is undefined", L(null), undefined);
  check("absent label is undefined", L({ id: 1, slug: "x" }), undefined);
  check("blank label is undefined, not empty string", L({ name: "   " }), undefined);
  check("non-string label is undefined", L({ name: 42 }), undefined);
}

/* -------------------------------------------------------------- page links */
console.log("\nbuilding a mod page URL (slug-addressed, not id-addressed)");
{
  R.setRegistryApiBase("https://cat.test");
  const U = R.modPageUrl;
  check("the API's own detail_url wins", U({ detailUrl: "https://cat.test/mods/sain", slug: "other" }), "https://cat.test/mods/sain");
  check("slug builds the plural form", U({ slug: "sain" }), "https://cat.test/mods/sain");
  check("slug is encoded", U({ slug: "a b" }), "https://cat.test/mods/a%20b");
  // The important negative: an id CANNOT make a URL, and inventing /mod/<id> would 404.
  check("nothing to go on yields undefined", U({}), undefined);
  check("a non-http detail_url is not trusted", U({ detailUrl: "javascript:alert(1)" }), undefined);
  check("addon pages use /addons/", R.addonPageUrl({ slug: "quick-sell" }), "https://cat.test/addons/quick-sell");
  R.setRegistryApiBase(null);
}

/* ---------------------------------------------------------- pasted mod refs */
console.log("\nparsing whatever the user pasted");
{
  const P = (s) => JSON.stringify(R.parseModRef(s));
  check("bare id", P("791"), JSON.stringify({ kind: "id", id: 791 }));
  check("bare id with spaces", P("  791  "), JSON.stringify({ kind: "id", id: 791 }));
  check("old Forge URL still readable", P("https://forge.sp-tarkov.com/mod/791/sain"), JSON.stringify({ kind: "id", id: 791 }));
  check("old Forge URL without slug", P("https://forge.sp-tarkov.com/mod/791"), JSON.stringify({ kind: "id", id: 791 }));
  check("successor slug URL", P("https://forge-alt.katrinfoxvr.com/mods/sain"), JSON.stringify({ kind: "slug", slug: "sain" }));
  // Host-agnostic on purpose: a mirror, a proxy or a future address must still read.
  check("slug URL from any host", P("https://anywhere.test/mods/sain"), JSON.stringify({ kind: "slug", slug: "sain" }));
  check("trailing path after slug is ignored", P("https://x.test/mods/sain/versions"), JSON.stringify({ kind: "slug", slug: "sain" }));
  check("query after slug is ignored", P("https://x.test/mods/sain?tab=v"), JSON.stringify({ kind: "slug", slug: "sain" }));
  check("percent-encoded slug is decoded", P("https://x.test/mods/a%20b"), JSON.stringify({ kind: "slug", slug: "a b" }));
  // /mod/ (singular) and /mods/ (plural) mean different things; confusing them is the trap.
  check("all-numeric slug is treated as an id", P("https://x.test/mods/791"), JSON.stringify({ kind: "id", id: 791 }));
  check("zero is rejected", P("0"), JSON.stringify(null));
  check("negative is rejected", P("-5"), JSON.stringify(null));
  check("prose is rejected", P("the sain mod"), JSON.stringify(null));
  check("empty is rejected", P(""), JSON.stringify(null));
  check("a URL with no mod path is rejected", P("https://x.test/about"), JSON.stringify(null));
}

/* ---------------------------------------------------------------- allowlist */
console.log("\nallowlisting what may be opened in a browser");
{
  R.setRegistryApiBase("https://cat.test");
  const A = R.isRegistryPageUrl;
  check("a mod page on the configured site", A("https://cat.test/mods/sain"), true);
  check("an addon page on the configured site", A("https://cat.test/addons/quick-sell"), true);
  check("an old Forge-style path on that site", A("https://cat.test/mod/791"), true);
  check("the site root is NOT a page", A("https://cat.test/"), false);
  check("an unrelated path on that site", A("https://cat.test/settings"), false);
  check("a different host", A("https://evil.test/mods/sain"), false);
  // The two shapes a prefix match would have let through.
  check("host as a prefix of another host", A("https://cat.test.evil.test/mods/sain"), false);
  check("the site URL smuggled in a query", A("https://evil.test/?x=https://cat.test/mods/sain"), false);
  check("http is refused", A("http://cat.test/mods/sain"), false);
  check("garbage is refused", A("not a url"), false);
  check("empty is refused", A(""), false);
  // Follows the configured address rather than a hardcoded one — the bug that made every
  // one of these links a no-op after the catalogue moved.
  R.setRegistryApiBase("https://elsewhere.test");
  check("old host stops being allowed after a switch", A("https://cat.test/mods/sain"), false);
  check("new host starts being allowed", A("https://elsewhere.test/mods/sain"), true);
  R.setRegistryApiBase(null);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
