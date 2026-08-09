/**
 * Server companion detection.
 *
 * The important property is not that detection works when the companion is there — it is that
 * EVERY other outcome reduces to "carry on as before". Almost no server will have this mod,
 * so a manager that errors, or that reports absence as a finding, would be broken against the
 * overwhelming majority of them.
 *
 * The distinction that matters most: a server with no companion is not a server with no
 * client mods. It is a server that cannot be asked. Those must never read the same, because
 * one of them would have someone delete mods they still need.
 */
const path = require("path");
const C = require(path.join(__dirname, "..", "dist-electron", "companion.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("\n=== server companion detection ===\n");

console.log("an ordinary SPT server");
{
  // 404 is the CORRECT answer from a server without the mod, and is not an error to report.
  const caps = C.readCapabilities(404, null);
  check("is not treated as present", caps.present, false);
  check("and nothing is claimed about it", [caps.manifest, caps.files], [false, false]);
  check("with no scary reason attached", caps.reason, undefined);
  // The wording must describe a limit on knowledge, not a fact about the server's mods.
  const said = C.describeCapabilities(caps);
  check("the summary says it cannot be asked", /cannot be read from it/.test(said), true);
  check("and does not claim it has none", /no client mods\b/.test(said), false);
}

console.log("\na companion that answers");
{
  const caps = C.readCapabilities(200, { version: "1.0.0", protocol: 1, capabilities: ["manifest", "files"] });
  check("is present", caps.present, true);
  check("with its version", caps.version, "1.0.0");
  check("offering the manifest", caps.manifest, true);
  check("and file serving", caps.files, true);
  check("summarised for a person", C.describeCapabilities(caps), "Server companion 1.0.0 connected — mods and addons, mod files.");
}

console.log("\ncapabilities are asked about by name, not inferred");
{
  // A companion may ship one before the other; this must not have to know release history.
  const partial = C.readCapabilities(200, { version: "0.9.0", protocol: 1, capabilities: ["manifest"] });
  check("manifest only", [partial.manifest, partial.files], [true, false]);
  const none = C.readCapabilities(200, { version: "0.1.0", protocol: 1, capabilities: [] });
  check("a companion offering nothing is still present", none.present, true);
  check("and says so plainly", /offers nothing this manager uses/.test(C.describeCapabilities(none)), true);
}

console.log("\nrefusing what cannot be understood");
{
  // Newer contract: guessing at fields whose meaning may have changed is worse than stopping,
  // and the message names the fix instead of failing obscurely somewhere later.
  const newer = C.readCapabilities(200, { version: "2.0.0", protocol: C.COMPANION_PROTOCOL + 1, capabilities: ["manifest"] });
  check("a newer contract is not used", newer.present, false);
  check("but the version is kept for the message", newer.version, "2.0.0");
  check("and it names the fix", /Update the manager/.test(newer.reason ?? ""), true);

  const noProtocol = C.readCapabilities(200, { version: "1.0.0", capabilities: ["manifest"] });
  check("an answer with no contract is refused", noProtocol.present, false);
}

console.log("\neverything else degrades quietly");
{
  check("500 is not present", C.readCapabilities(500, null).present, false);
  check("and says what happened", /answered 500/.test(C.readCapabilities(500, null).reason ?? ""), true);
  check("unreachable is not present", C.readCapabilities(0, null).present, false);
  check("a non-object body is refused", C.readCapabilities(200, "hello").present, false);
  check("null body is refused", C.readCapabilities(200, null).present, false);

  // A token is required and this manager has none: a different problem from absence, with a
  // different fix, so it is reported differently.
  const denied = C.readCapabilities(401, null);
  check("unauthorised is flagged", denied.unauthorised, true);
  check("not present", denied.present, false);
  check("and names the cause", /token/.test(denied.reason ?? ""), true);
  check("403 is treated the same", C.readCapabilities(403, null).unauthorised, true);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
