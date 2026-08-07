/**
 * The self-update extraction, run INSIDE Electron.
 *
 * This test exists because the bug it guards could not be caught any other way. Electron
 * patches `fs` so that any path containing ".asar" is treated as an archive to look inside
 * rather than as an ordinary file. Every release zip contains `resources/app.asar`, so
 * extracting one from inside the app failed with:
 *
 *   ENOENT: no such file or directory, chmod '...\resources\app.asar'
 *
 * The identical extraction succeeds in plain Node. The whole test suite runs in plain Node,
 * which is precisely why a broken self-update shipped in v1.2.2.
 *
 * Run with:  npm run test:asar    (which launches electron, not node)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require(path.join(__dirname, "..", "node_modules", "adm-zip"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-asar-"));

/** A zip shaped like a real release: an app.asar inside resources/. */
function makeReleaseZip() {
  const zip = new AdmZip();
  zip.addFile("SPTarky Mod Manager Spicy.exe", Buffer.from("MZ fake exe"));
  zip.addFile("resources/app.asar", Buffer.alloc(4096, 0x41));
  zip.addFile("resources/app.asar.unpacked/node_modules/keep.txt", Buffer.from("x"));
  zip.addFile("locales/en-US.pak", Buffer.from("pak"));
  const p = path.join(root, "release.zip");
  zip.writeZip(p);
  return p;
}

function main() {
  console.log(`running under electron ${process.versions.electron ?? "(NOT ELECTRON - this test is meaningless)"}`);
  check("this really is Electron", typeof process.versions.electron, "string");

  const zipPath = makeReleaseZip();

  console.log("\nextracting a release-shaped zip with asar interception ON (the shipped bug)");
  {
    const staging = path.join(root, "staging-default");
    fs.mkdirSync(staging, { recursive: true });
    let failed = null;
    try {
      new AdmZip(zipPath).extractAllTo(staging, true);
    } catch (err) {
      failed = err.message;
    }
    // Documented, not asserted as desirable: this is what the user saw. If a future Electron
    // stops intercepting, this check flipping is good news and worth noticing deliberately.
    console.log(`  (interception ${failed ? "still bites: " + failed.slice(0, 60) : "no longer bites"})`);
  }

  console.log("\nextracting with process.noAsar = true (the fix)");
  {
    const staging = path.join(root, "staging-noasar");
    fs.mkdirSync(staging, { recursive: true });
    const previous = process.noAsar;

    // The guard has to cover every fs touch, not just the extraction. Asserting on the
    // results OUTSIDE it made existsSync/statSync go straight back through the asar wrapper
    // and fail — which is exactly why prepareUpdate wraps its whole body rather than just
    // the extractAllTo call.
    process.noAsar = true;
    let failed = null;
    let removeFailed = null;
    try {
      new AdmZip(zipPath).extractAllTo(staging, true);

      check("extraction succeeds", failed, null);
      check("app.asar is a real file on disk", fs.existsSync(path.join(staging, "resources", "app.asar")), true);
      check("and has its bytes", fs.statSync(path.join(staging, "resources", "app.asar")).size, 4096);
      check("the exe came out too", fs.existsSync(path.join(staging, "SPTarky Mod Manager Spicy.exe")), true);
      check(
        "so did the unpacked sidecar",
        fs.existsSync(path.join(staging, "resources", "app.asar.unpacked", "node_modules", "keep.txt")),
        true
      );

      // Cleanup walks through app.asar as well, so it needs the same guard.
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch (err) {
        removeFailed = err.message;
      }
      check("removing the staging folder also works", removeFailed, null);
    } catch (err) {
      failed = err.message;
      check("extraction succeeds", failed, null);
    } finally {
      process.noAsar = previous;
    }
  }

  console.log("\nthe flag is restored afterwards");
  {
    // Leaving interception off would change how require() resolves against the packaged app,
    // far outside anything to do with updating.
    const before = process.noAsar;
    const previous = process.noAsar;
    process.noAsar = true;
    process.noAsar = previous;
    check("back to what it was", process.noAsar, before);
  }

  // The temp tree still holds an app.asar, so tearing it down needs the guard too.
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    process.noAsar = previous;
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
