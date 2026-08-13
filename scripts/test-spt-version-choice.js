/**
 * Which SPT version the app answers everything against.
 *
 * The rules are small and the consequences are not: this number decides which builds an update
 * check resolves, what browse filters to, and whether a mod is called compatible. Every way of
 * getting it wrong is QUIET — nothing errors, the answers are just about a different install.
 *
 * The one rule the rest follows from: the stored override means "the user chose to DIFFER", and
 * is never written to record the instance's own version. The checks below are mostly about what
 * that buys.
 *
 * Compiled with esbuild because this lives in `src/` and is otherwise only bundled by Vite.
 */
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const out = path.join(__dirname, "..", "dist-electron", "__sptVersionChoice.test.js");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "sptVersionChoice.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent"
});
const { versionOnOpen, overrideToStore, needsConfirmation, onInstanceChanged } = require(out);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("\n=== which SPT version the app answers for ===\n");

console.log("opening an instance");
{
  check("the instance speaks for itself", versionOnOpen({ detected: "4.0.13", stored: "" }), "4.0.13");
  check("a deliberate override wins", versionOnOpen({ detected: "4.0.13", stored: "4.1.0" }), "4.1.0");
  // Nothing invented: the placeholder shows rather than a guessed number.
  check("neither leaves it empty", versionOnOpen({ detected: "", stored: "" }), "");
  check("an override alone is still used", versionOnOpen({ detected: "", stored: "4.1.0" }), "4.1.0");
}

console.log("\nwhat gets stored");
{
  // The rule everything else rests on.
  check("choosing the instance's own version stores NOTHING", overrideToStore("4.0.13", "4.0.13"), "");
  check("choosing a different one stores it", overrideToStore("4.1.0", "4.0.13"), "4.1.0");
  check("clearing stores nothing", overrideToStore("", "4.0.13"), "");
}

console.log("\nSPT upgraded in place, underneath the install");
{
  /*
   * The case that makes storing an adopted value harmful. Someone on 4.0.13 updates SPT to
   * 4.0.14. Had 4.0.13 been pinned as though it were a choice, every answer would keep
   * describing the version they used to have — silently, and forever.
   */
  const storedAfterAdopting = overrideToStore("4.0.13", "4.0.13");
  check("nothing was pinned", storedAfterAdopting, "");
  check("so the new version is picked up on its own", versionOnOpen({ detected: "4.0.14", stored: storedAfterAdopting }), "4.0.14");

  // A DELIBERATE override still survives the upgrade, because it was a choice.
  check("a real override is not lost", versionOnOpen({ detected: "4.0.14", stored: "4.1.0" }), "4.1.0");
}

console.log("\npointing at a different instance");
{
  // An override belongs to the folder it was chosen for. Carrying it across would answer for an
  // install nobody has open.
  check("the new instance's version is adopted", onInstanceChanged("4.1.0", "4.0.13"), { value: "4.1.0", store: "" });
  check("and the old override is dropped", onInstanceChanged("4.1.0", "4.1.5").store, "");
  // A folder that says nothing about itself: the stored value is all there is, and it is kept
  // rather than replaced with a blank.
  check("an unreadable folder falls back to what was stored", onInstanceChanged("", "4.0.13"), { value: "4.0.13", store: "4.0.13" });
  check("with nothing anywhere, nothing is invented", onInstanceChanged("", ""), { value: "", store: "" });
}

console.log("\nwhen leaving the instance's version needs confirming");
{
  check("departing from it does", needsConfirmation("4.1.0", "4.0.13"), true);
  // Returning is always free — confirming it would train people to click through the dialog
  // that actually matters.
  check("returning to it does not", needsConfirmation("4.0.13", "4.0.13"), false);
  check("with no instance version there is nothing to leave", needsConfirmation("4.1.0", ""), false);
  check("and clearing the box is not a departure", needsConfirmation("", "4.0.13"), false);
}

console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
try {
  fs.unlinkSync(out);
} catch {}
process.exit(failures === 0 ? 0 : 1);
