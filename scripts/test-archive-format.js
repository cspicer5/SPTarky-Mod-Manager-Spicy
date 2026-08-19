/**
 * What an archive IS, versus what it is called.
 *
 * Extraction used to be dispatched on the file extension, which is a guess dressed as a fact.
 * Couturier - gear and clothing pack made that visible: the catalogue's download URL ends in
 * `/2.0.4`, so there is no extension to read, the code defaulted to `.zip`, and the link
 * redirects to `Couturier2.0.4.7z` on the author's own host. AdmZip was handed a 7-Zip archive
 * and answered "Invalid or unsupported zip format. No END header found" — a complaint about the
 * reader, not a description of the file, and nothing a person could act on.
 *
 * These check the bytes, with the extension deliberately lying in every case, because that is the
 * situation that actually occurs: mods are hosted anywhere, named anything, and renamed by hand.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { detectArchiveFormat } = require(path.join(__dirname, "..", "dist-electron", "modManager.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${String(expected)}, got ${String(actual)}`}`
  );
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-archive-"));
const write = (name, bytes) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, Buffer.from(bytes));
  return f;
};

console.log("\n=== archive format, read from the bytes ===\n");

console.log("the name lies, the signature does not");
{
  // The exact shape of the reported bug: a 7-Zip archive arriving under a .zip name.
  check("a 7z named .zip", detectArchiveFormat(write("mod.zip", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0])), ".7z");
  check("a zip named .7z", detectArchiveFormat(write("mod.7z", [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), ".zip");
  // RAR4 and RAR5 share the first four bytes, so one check covers both.
  check("a rar named .zip", detectArchiveFormat(write("r.zip", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0])), ".rar");
}

console.log("\nzip variants that are still zips");
{
  // Refusing these would reject archives that open perfectly well.
  check("an EMPTY archive (PK\x05\x06)", detectArchiveFormat(write("empty.zip", [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])), ".zip");
  check("a SPANNED archive (PK\x07\x08)", detectArchiveFormat(write("span.zip", [0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0])), ".zip");
}

console.log("\nthings that are not archives at all");
{
  /*
   * These must come back UNRECOGNISED rather than being guessed at. The extraction path falls
   * back to the extension for exactly these, so the real extractor produces a real error about
   * the real file — and the caller says "most likely an incomplete download", which is what it
   * almost always is.
   */
  check("an HTML error page saved as .zip", detectArchiveFormat(write("err.zip", Buffer.from("<!DOCTYPE html><html>"))), undefined);
  check("a truncated download", detectArchiveFormat(write("half.zip", [0, 0, 0, 0, 0, 0, 0, 0])), undefined);
  check("a file shorter than a signature", detectArchiveFormat(write("tiny.zip", [0x50, 0x4b])), undefined);
  check("a file that does not exist", detectArchiveFormat(path.join(tmp, "absent.zip")), undefined);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
