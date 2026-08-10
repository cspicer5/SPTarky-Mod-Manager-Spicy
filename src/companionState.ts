/**
 * What is known about the companion on a SERVER, as opposed to on this PC.
 *
 * Split out of the component so it can be tested without rendering: the distinction it draws
 * is the kind that is easy to get quietly wrong and impossible to see in a screenshot.
 *
 * "Unreachable" and "absent" are different answers and must never collapse into one. A server
 * that is simply switched off — the normal state of somebody else's machine — has told us
 * NOTHING about whether it runs the companion. Rendering that as "not installed" would invite
 * someone to install it onto a machine that already has it, or to conclude the feature is
 * broken when nothing is wrong.
 */
import { ServerSyncReport } from "./types";

/**
 * The companion itself, which is not a mod and must not be listed as one.
 *
 * It is infrastructure this app installs to answer questions about a server — nobody chose it as
 * content, it changes nothing in a raid, and it is installed and removed from its own box in the
 * header. Listing it among the mods put a ✕ beside it that would break the very connection the
 * pane is reporting on, and it inflated the install's mod count by one against every other
 * instance.
 *
 * The comparison already excluded it on the SERVER side for the same reason (a mismatch there is
 * always expected and never actionable); this is the local half of that rule.
 *
 * Matched on GUID first, so renaming the folder does not smuggle it back into the list.
 */
export function isCompanionMod(mod: { id?: string; name?: string; guid?: string }): boolean {
  if (mod.guid && mod.guid.trim().toLowerCase() === "com.sptarky.companion") return true;
  const named = (value?: string) => (value ?? "").trim().toLowerCase() === "sptarkycompanion";
  return named(mod.id) || named(mod.name);
}

export type CompanionServerState =
  /** No server is being tracked, so nothing can be said about one. */
  | { kind: "none" }
  /** A server is tracked but has not been contacted yet this session. Nothing was attempted. */
  | { kind: "unchecked" }
  /** We tried and failed. NOT evidence of absence. */
  | { kind: "unreachable" }
  | { kind: "active"; version?: string }
  /** It answered, and it has no usable companion. This one IS a finding. */
  | { kind: "absent"; reason?: string };

export function readServerCompanion(
  report: ServerSyncReport | null,
  serverUrl: string | null
): CompanionServerState {
  if (!serverUrl) return { kind: "none" };

  // "Not asked yet" is kept apart from "asked and failed", which reading the live UI proved
  // was worth doing: on startup the app has a stored server address but has fetched nothing,
  // and calling that "unreachable" accuses a server that is sitting there answering fine.
  // Both mean "unknown", but only one of them is a claim about the server.
  if (!report) return { kind: "unchecked" };

  if (!report.reachable) return { kind: "unreachable" };
  if (report.companionPresent) return { kind: "active", version: report.companionVersion };
  return { kind: "absent", reason: report.companionReason };
}
