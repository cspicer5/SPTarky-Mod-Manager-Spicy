/**
 * Dependency checking.
 *
 * Every case here is one the live catalogue actually produces, checked against it before this
 * was written. The three that matter most are the ones easiest to collapse into each other:
 *
 *   missing              not installed, a compatible build exists  -> offer to install it
 *   no-compatible-build  not installed, NO build fits this SPT     -> installing cannot help
 *   unknown              the catalogue had no answer at all        -> say so, do not imply OK
 *
 * Reporting an unreachable catalogue as "nothing missing" is the failure this module exists
 * to prevent, so silence and success are kept apart at every level.
 *
 * The network is stubbed. What is being tested is the interpretation, not the site's uptime —
 * a suite that needed the catalogue up would fail for reasons that are not this code's fault.
 */
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const D = require(path.join(dist, "dependencies.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

/**
 * `guids` and `ids` accept either "guid" or ["guid", "installedVersion"], because a
 * dependency is only worth raising when the mod needs something NEWER than what is there.
 */
const idx = (guids = [], ids = []) => ({
  byGuid: new Map(guids.map((g) => (Array.isArray(g) ? [g[0].toLowerCase(), g[1]] : [g.toLowerCase(), undefined]))),
  byCatalogueId: new Map(ids.map((i) => (Array.isArray(i) ? i : [i, undefined])))
});

const dep = (id, name, extra = {}) => ({
  id,
  name,
  guid: extra.guid ?? `guid.${name.toLowerCase()}`,
  slug: name.toLowerCase(),
  conflict: extra.conflict ?? false,
  latest_compatible_version:
    extra.build === null ? null : { id: 1, version: extra.build ?? "1.0.0", link: `https://x/${name}.7z` },
  dependencies: extra.dependencies ?? []
});

/** A stub standing in for the catalogue, recording what it was asked. */
function stubFetch(responder) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const r = responder(String(url));
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: async () => r.body
    };
  };
  fn.calls = calls;
  return fn;
}

console.log("\n=== dependency checking ===\n");

console.log("classifying one mod's dependencies");
{
  const roots = [
    dep(902, "BigBrain"), // installed
    dep(827, "Waypoints"), // missing, build available
    dep(555, "OldThing", { build: null }) // not installed, no build for this SPT
  ];
  const installed = idx([["guid.bigbrain", "1.0.0"]], []);
  const out = D.flattenDependencies(roots, installed);
  check("BigBrain is satisfied by guid", out.find((r) => r.modId === 902).status, "satisfied");
  check("Waypoints is missing", out.find((r) => r.modId === 827).status, "missing");
  check("a null build is NOT reported as missing", out.find((r) => r.modId === 555).status, "no-compatible-build");
  check("the missing one carries a download link", !!out.find((r) => r.modId === 827).downloadLink, true);
  check("the unavailable one carries none", out.find((r) => r.modId === 555).downloadLink, undefined);
}

console.log("\nonly flag when the mod needs something NEWER than what is installed");
{
  // The rule that keeps this readable. WTT - CommonLib resolves to 2.0.5 for one mod and
  // 2.0.23 for another on the reference install, with 2.0.23 present: nothing to say.
  const roots = [dep(2310, "CommonLib", { build: "2.0.5" })];
  check("newer installed -> satisfied", D.flattenDependencies(roots, idx([["guid.commonlib", "2.0.23"]], []))[0].status, "satisfied");
  check("exactly equal -> satisfied", D.flattenDependencies(roots, idx([["guid.commonlib", "2.0.5"]], []))[0].status, "satisfied");
  check("older installed -> outdated", D.flattenDependencies(roots, idx([["guid.commonlib", "2.0.4"]], []))[0].status, "outdated");
  // Numeric, not lexical: as strings "2.0.5" > "2.0.23" and this would invert.
  check("2.0.23 is newer than 2.0.5", D.compareVersions("2.0.23", "2.0.5"), 1);
  const outdated = D.flattenDependencies(roots, idx([["guid.commonlib", "2.0.4"]], []))[0];
  check("an outdated entry reports both versions", [outdated.installedVersion, outdated.version], ["2.0.4", "2.0.5"]);
  // An unreadable installed version is not evidence of being out of date.
  check("installed, version unknown -> satisfied", D.flattenDependencies(roots, idx(["guid.commonlib"], []))[0].status, "satisfied");
}

console.log("\nthe upgrade target is bounded by the SPT version");
{
  /*
   * The endpoint resolves latest_compatible_version against the spt_version it was given, so
   * the build named is the newest that RUNS here, not the newest published. BigBrain 1.5.0
   * targets SPT ~4.1.0; asked about 4.0.13 the answer is 1.4.0. A check that ignored this
   * would tell someone on 4.0.13 to "upgrade" onto a build their SPT cannot load.
   */
  const onOldSpt = [dep(902, "BigBrain", { build: "1.4.0" })]; // what 4.0.13 resolves to
  check(
    "having the SPT-appropriate build is enough",
    D.flattenDependencies(onOldSpt, idx([["guid.bigbrain", "1.4.0"]], []))[0].status,
    "satisfied"
  );
  check(
    "and it never points past what SPT allows",
    D.flattenDependencies(onOldSpt, idx([["guid.bigbrain", "1.3.0"]], []))[0].version,
    "1.4.0"
  );
  // Installed BEYOND what this SPT resolves to — still satisfied, never a downgrade prompt.
  check(
    "a newer-than-resolved install is left alone",
    D.flattenDependencies(onOldSpt, idx([["guid.bigbrain", "1.5.0"]], []))[0].status,
    "satisfied"
  );
  // Nothing fits this SPT at all: installed stays satisfied (it is running), absent is a
  // real problem that installing cannot solve.
  const noBuild = [dep(902, "BigBrain", { build: null })];
  check("installed with no compatible build -> satisfied", D.flattenDependencies(noBuild, idx([["guid.bigbrain", "1.4.0"]], []))[0].status, "satisfied");
  check("absent with no compatible build -> no-compatible-build", D.flattenDependencies(noBuild, idx([], []))[0].status, "no-compatible-build");
}

console.log("\nconflict is BATCH-scoped, and orthogonal to being installed");
{
  /*
   * Established live: WTT-Artem alone reports CommonLib conflict=false, ISBAishi alone
   * reports false, and the two together report TRUE — they resolve CommonLib to 2.0.5 and
   * 2.0.23 respectively. Treating conflict as a status that outranked "satisfied" marked
   * CommonLib unmet on thirteen mods of the reference install while it was installed and
   * working.
   */
  const roots = [dep(2310, "CommonLib", { build: "2.0.5", conflict: true })];
  const out = D.flattenDependencies(roots, idx([["guid.commonlib", "2.0.23"]], []))[0];
  check("an installed mod stays satisfied", out.status, "satisfied");
  check("and the conflict is reported alongside", out.conflict, true);
}

console.log("\nrecognising what is already installed");
{
  const roots = [dep(902, "BigBrain")];
  check("by guid", D.flattenDependencies(roots, idx([["guid.bigbrain", "9.9.9"]], []))[0].status, "satisfied");
  check("by guid, case-insensitively", D.flattenDependencies(roots, idx([["GUID.BIGBRAIN", "9.9.9"]], []))[0].status, "satisfied");
  // The match cache answers for mods whose files declare no guid at all.
  check("by catalogue id from the match cache", D.flattenDependencies(roots, idx([], [[902, "9.9.9"]]))[0].status, "satisfied");
  check("neither -> missing", D.flattenDependencies(roots, idx([], []))[0].status, "missing");
}

console.log("\ntransitive dependencies");
{
  // Measured on the live catalogue: MoreBotsAPI carries BigBrain; Content Backport carries CommonLib.
  const roots = [dep(2426, "MoreBotsAPI", { dependencies: [dep(902, "BigBrain")] })];
  const out = D.flattenDependencies(roots, idx([], []));
  check("both levels are reported", out.length, 2);
  check("the declared one is not transitive", out.find((r) => r.modId === 2426).transitive, false);
  check("the nested one is", out.find((r) => r.modId === 902).transitive, true);
  check("and names what pulled it in", out.find((r) => r.modId === 902).via, "MoreBotsAPI");
}

console.log("\ncycles (Painter and Tactical Gear Component declare each other)");
{
  const painter = dep(1, "Painter");
  const tgc = dep(2, "TacticalGear");
  painter.dependencies = [tgc];
  tgc.dependencies = [painter]; // the loop the live catalogue really contains
  const out = D.flattenDependencies([painter], idx([], []));
  check("it terminates", out.length, 2);
  check("each mod appears exactly once", out.map((r) => r.modId), [1, 2]);
  // The first route wins, so a directly declared dependency is not relabelled as transitive
  // by a later path that happens to reach it again.
  check("the root keeps its direct status", out[0].transitive, false);
}

console.log("\nduplicate arrivals");
{
  // Two dependencies that share one. It must be listed once, as declared, not twice.
  const roots = [
    dep(10, "A", { dependencies: [dep(902, "BigBrain")] }),
    dep(902, "BigBrain")
  ];
  const out = D.flattenDependencies(roots, idx([], []));
  check("BigBrain appears once", out.filter((r) => r.modId === 902).length, 1);
}

console.log("\nfetching: absent key is not an empty list");
{
  const fetchImpl = stubFetch(() => ({
    body: { data: { "791:4.4.3": [dep(902, "BigBrain")] }, success: true }
  }));
  (async () => {
    const found = await D.fetchDependencies(["791:4.4.3", "999:1.0.0"], "4.0.13", fetchImpl);
    check("the answered mod is present", found.byMod.get("791:4.4.3").length, 1);
    check("the unanswered mod is unknown", found.unknown.has("999:1.0.0"), true);
    check("and is NOT recorded as having none", found.byMod.has("999:1.0.0"), false);

    const empty = stubFetch(() => ({ body: { data: { "31:1.0.8": [] }, success: true } }));
    const none = await D.fetchDependencies(["31:1.0.8"], "4.0.13", empty);
    check("a present empty array means genuinely none", none.byMod.get("31:1.0.8"), []);
    check("and is not unknown", none.unknown.has("31:1.0.8"), false);

    console.log("\nfetching: failures never look like success");
    const boom = stubFetch(() => ({ ok: false, status: 500, body: {} }));
    const failed = await D.fetchDependencies(["791:4.4.3"], "4.0.13", boom);
    check("an HTTP error marks the mod unknown", failed.unknown.has("791:4.4.3"), true);

    const thrower = async () => {
      throw new Error("network down");
    };
    const threw = await D.fetchDependencies(["791:4.4.3"], "4.0.13", thrower);
    check("a thrown error is caught, not propagated", threw.unknown.has("791:4.4.3"), true);

    // spt_version is required by the API; guessing one would answer for the wrong SPT.
    const noSpt = await D.fetchDependencies(["791:4.4.3"], "", boom);
    check("no SPT version is refused before any request", !!noSpt.error, true);
    check("and nothing was requested", boom.calls.length, 1);

    console.log("\nfetching: batching and keying");
    const many = [];
    for (let i = 0; i < 30; i++) many.push(`${i}:1.0.0`);
    const batcher = stubFetch(() => ({ body: { data: {}, success: true } }));
    await D.fetchDependencies(many, "4.0.13", batcher);
    check("30 mods are split into 3 requests of 12", batcher.calls.length, 3);
    // Response keys arrive out of request order on the live API, so nothing may depend on it.
    const shuffled = stubFetch(() => ({
      body: { data: { "2:1.0.0": [dep(5, "Five")], "1:1.0.0": [] }, success: true }
    }));
    const byKey = await D.fetchDependencies(["1:1.0.0", "2:1.0.0"], "4.0.13", shuffled);
    check("results are matched by key, not position", byKey.byMod.get("2:1.0.0").length, 1);
    check("and the other key stays empty", byKey.byMod.get("1:1.0.0"), []);
    check("duplicate requests are de-duplicated", (await D.fetchDependencies(["1:1", "1:1"], "4.0.13", stubFetch(() => ({ body: { data: {}, success: true } })))).unknown.size, 1);

    console.log("\nthe one-line summary");
    const sum = (c, n = "SAIN") => D.describeDependencyCheck(c, n);
    check(
      "missing is named",
      sum({ reports: [1], missing: [{ name: "BigBrain" }], unavailable: [], conflicts: [], unknown: false }),
      '"SAIN": 1 missing dependency(ies): BigBrain.'
    );
    check(
      "no answer is not a clean bill of health",
      sum({ reports: [], missing: [], outdated: [], unavailable: [], conflicts: [], unknown: true }),
      'The catalogue had no dependency information for "SAIN".'
    );
    check(
      "an error says so",
      sum({ reports: [], missing: [], unavailable: [], conflicts: [], unknown: false, error: "network down" }),
      `Couldn't check what "SAIN" needs: network down`
    );
    check(
      "declaring none reads differently from having them all",
      sum({ reports: [], missing: [], outdated: [], unavailable: [], conflicts: [], unknown: false }),
      '"SAIN" declares no dependencies.'
    );
    check(
      "all satisfied",
      sum({ reports: [1], missing: [], outdated: [], unavailable: [], conflicts: [], unknown: false }),
      '"SAIN" has everything it needs.'
    );

    console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
  })();
}
