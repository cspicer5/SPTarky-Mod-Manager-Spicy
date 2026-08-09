/**
 * What the browse list's button says, and why that matters.
 *
 * The browse pane offers a version dropdown next to an install button. Before this, the
 * button said "Install" regardless — including for a mod you already had, at the version you
 * already had. Two things were wrong with that:
 *
 *   - it reads as "you don't have this", hiding that the button overwrites what is there;
 *   - it makes a DOWNGRADE indistinguishable from an upgrade, because in a dropdown an older
 *     build looks exactly like a newer one. That is the expensive mistake: you press a button
 *     labelled the same as always and quietly roll a mod backwards.
 *
 * Which installed mod a catalogue entry corresponds to is read from the match cache, NOT
 * guessed by name — the cache only ever stores identities the app is confident about. Name
 * guessing is what once mapped fika-server onto SVM.
 *
 * This suite is compiled on the fly with esbuild because the module lives under src/ (the
 * renderer), which is otherwise only ever bundled by Vite. The logic is worth testing
 * directly rather than by clicking, since every branch is a different sentence shown to the
 * user and three of the five are about not misleading them.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const src = path.join(__dirname, "..", "src", "browseInstallState.ts");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-browse-")), "browseInstallState.js");
esbuild.buildSync({ entryPoints: [src], outfile: out, format: "cjs", platform: "node", bundle: false });
const { browseInstallState, compareSemver } = require(out);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

/** An installed part, with only the fields this logic reads. */
const part = (version, versionSource) => ({ id: "x", name: "x", originalName: "x", type: "client", enabled: true, installedManually: false, loadOrder: 0, version, versionSource });

console.log("\n=== browse install state ===\n");

console.log("nothing installed");
check("undefined -> Install", browseInstallState(undefined, "1.0.0"), { kind: "install" });
check("empty list -> Install", browseInstallState([], "1.0.0"), { kind: "install" });

console.log("\nsame version installed");
check("exact match -> Reinstall", browseInstallState([part("1.2.0", "recorded")], "1.2.0"), {
  kind: "reinstall",
  installedVersion: "1.2.0"
});
// Published versions are not disciplined; these all mean the same thing and must not read
// as an upgrade or a downgrade.
check("leading v is ignored", browseInstallState([part("1.2.0", "recorded")], "v1.2.0"), {
  kind: "reinstall",
  installedVersion: "1.2.0"
});
check("trailing .0 is ignored", browseInstallState([part("1.2.0", "recorded")], "1.2.0.0"), {
  kind: "reinstall",
  installedVersion: "1.2.0"
});
check("missing patch is ignored", browseInstallState([part("1.2.0", "recorded")], "1.2"), {
  kind: "reinstall",
  installedVersion: "1.2.0"
});

console.log("\ndirection of change");
check("newer -> Upgrade", browseInstallState([part("1.2.0", "recorded")], "1.3.0"), {
  kind: "upgrade",
  installedVersion: "1.2.0"
});
check("older -> Downgrade", browseInstallState([part("1.2.0", "recorded")], "1.1.0"), {
  kind: "downgrade",
  installedVersion: "1.2.0"
});
// The comparison must be numeric. As strings, "0.9.0" > "0.10.0", which would label a real
// upgrade as a downgrade and vice versa.
check("0.10.0 is newer than 0.9.0", browseInstallState([part("0.9.0", "recorded")], "0.10.0"), {
  kind: "upgrade",
  installedVersion: "0.9.0"
});
check("0.9.0 is older than 0.10.0", browseInstallState([part("0.10.0", "recorded")], "0.9.0"), {
  kind: "downgrade",
  installedVersion: "0.10.0"
});
check("the real case: 0.2.2 -> 0.2.3", browseInstallState([part("0.2.2", "recorded")], "0.2.3"), {
  kind: "upgrade",
  installedVersion: "0.2.2"
});

console.log("\nwhich installed version is believed");
// A mod's halves share a version, and a RECORDED one outranks a declared one: several
// authors never update their declaration, so trusting it shows a phantom upgrade forever.
check(
  "recorded wins over declared, whatever the order",
  browseInstallState([part("2.0.9", "assembly"), part("2.1.4", "recorded")], "2.1.4"),
  { kind: "reinstall", installedVersion: "2.1.4" }
);
check(
  "falls back to a declared version when nothing is recorded",
  browseInstallState([part("2.0.9", "assembly")], "2.1.0"),
  { kind: "upgrade", installedVersion: "2.0.9" }
);
// stale-record means the files changed since; it is still the app's own record, and it is
// still a better answer than inventing a direction.
check("a stale record is still used", browseInstallState([part("1.0.0", "stale-record")], "1.0.0"), {
  kind: "reinstall",
  installedVersion: "1.0.0"
});

console.log("\nnothing trustworthy to compare");
check("installed with no version at all", browseInstallState([part(undefined, undefined)], "1.0.0"), {
  kind: "installed-unknown"
});
check("no version selected", browseInstallState([part("1.0.0", "recorded")], undefined), {
  kind: "installed-unknown"
});

console.log("\ncompareSemver directly");
check("equal", compareSemver("1.0.0", "1.0.0"), 0);
check("greater", compareSemver("1.0.1", "1.0.0"), 1);
check("less", compareSemver("1.0.0", "1.0.1"), -1);
check("numeric, not lexical", compareSemver("0.10.0", "0.9.0"), 1);
check("whitespace tolerated", compareSemver(" 1.0.0 ", "1.0.0"), 0);
check("non-numeric part reads as 0", compareSemver("1.0.beta", "1.0.0"), 0);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
