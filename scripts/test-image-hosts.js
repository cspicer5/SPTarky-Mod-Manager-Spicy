/**
 * The Referer attached to catalogue thumbnail requests.
 *
 * files.sp-mod.com is hotlink-protected: without the catalogue's own Referer it answers
 * `403 Nope`, and a packaged build loads its UI from file://, which sends no Referer at all.
 * Every icon in the mod browser was refused.
 *
 * The failure mode is what makes this worth pinning. A refused <img> keeps its element and its
 * src, so the DOM looks correct; and successful responses cache for 31 days, so icons fetched
 * before the host started checking kept rendering. The result reads as "some mods have icons
 * and some don't" — a content problem — rather than as a broken request.
 *
 * Verified on the wire after the fix: 40 requests, all 200, all carrying the Referer, none
 * from cache, 23 of 23 thumbnails decoded.
 */
const path = require("path");
const { refererForUrl, IMAGE_HOST_REFERERS } = require(path.join(__dirname, "..", "dist-electron", "imageHosts.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("the image host gets the Referer it demands");
{
  check(
    "a thumbnail URL resolves",
    refererForUrl("https://files.sp-mod.com/mods/1861.png"),
    "https://sp-mod.com/"
  );
  check(
    "and so does one with a hashed name",
    refererForUrl("https://files.sp-mod.com/mods/FVbVeBHaQuaij0cbN9akYctRp36WNPNU6FYzarMw.png"),
    "https://sp-mod.com/"
  );

  /*
   * THE non-obvious one. Measured against the live host:
   *   https://sp-mod.com/  -> 200
   *   https://sp-mod.com   -> 403
   * A "tidy up" that strips it breaks every icon in the app, silently.
   */
  const value = IMAGE_HOST_REFERERS["files.sp-mod.com"];
  check("the trailing slash survives", value.endsWith("/"), true);
  check("and the value is exactly what the host accepts", value, "https://sp-mod.com/");
}

console.log("\nand nothing else does");
{
  // Scope is the whole safety argument for sending this header at all. The catalogue's own
  // client showing the catalogue's own images is the traffic hotlink protection exists to
  // serve; that reasoning does not extend to any other host, so neither does the header.
  check("the API host does not get it", refererForUrl("https://sp-mod.com/api/v0/mods"), undefined);
  check("GitHub downloads do not", refererForUrl("https://github.com/owner/repo/releases/download/v1/a.zip"), undefined);
  check("nor does a lookalike domain", refererForUrl("https://files.sp-mod.com.evil.test/mods/1.png"), undefined);
  check("nor a subdomain of the image host", refererForUrl("https://cdn.files.sp-mod.com/mods/1.png"), undefined);
}

console.log("\nhostile input passes through rather than throwing");
{
  // This sits in the path of EVERY request the app makes. Throwing here would not break
  // thumbnails, it would break the app.
  check("a malformed URL", refererForUrl("not a url"), undefined);
  check("an empty string", refererForUrl(""), undefined);
  check("a data URI", refererForUrl("data:image/png;base64,iVBORw0KGgo="), undefined);
  check("a file URL", refererForUrl("file:///D:/app/dist/index.html"), undefined);
}

console.log("\nhost matching is case-insensitive");
{
  // Hostnames are case-insensitive per RFC 3986, and a URL arriving with different casing
  // would otherwise miss the map and silently lose its icons.
  check("uppercase host still matches", refererForUrl("https://FILES.SP-MOD.COM/mods/1.png"), "https://sp-mod.com/");
}

console.log(failures === 0 ? "\nAll image host checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
