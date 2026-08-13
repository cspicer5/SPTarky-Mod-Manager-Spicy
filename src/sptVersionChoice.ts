/**
 * Which SPT version everything is answered against, and when the user is allowed to differ.
 *
 * This one number decides a lot: which builds an update check resolves, what browse filters to,
 * and whether a mod is called compatible. Getting it wrong is quiet — nothing errors, the answers
 * are simply about a different install.
 *
 * The rule that makes the rest fall out: **the stored override means "the user chose to DIFFER",
 * and nothing else.** It is never written to record the instance's own version.
 *
 * Storing an adopted value looks harmless and is not. Once 4.0.13 is pinned as though it were a
 * choice, it is indistinguishable from one later — so upgrading SPT underneath the install leaves
 * every answer describing the version you used to have, and switching to another instance carries
 * the previous one's number across as though it had been detected there.
 */

export interface SptVersionState {
  /** What the folder itself says it is. Empty when nothing could be read. */
  detected: string;
  /** The stored override, if the user chose to differ. */
  stored: string;
}

/**
 * The version to show when an instance is opened.
 *
 * A deliberate override wins; otherwise the instance speaks for itself. With neither, the empty
 * string leaves the placeholder showing rather than inventing a number.
 */
export function versionOnOpen({ detected, stored }: SptVersionState): string {
  return stored || detected || "";
}

/**
 * What to persist when a version is chosen.
 *
 * Empty means "clear it" — choosing the instance's own version is not an override, it is the
 * absence of one, and recording it would pin a number that should keep tracking the folder.
 */
export function overrideToStore(chosen: string, detected: string): string {
  if (!chosen) return "";
  return chosen === detected ? "" : chosen;
}

/**
 * Whether leaving this version needs confirming.
 *
 * Only when there is an instance version to leave AND the choice departs from it. Returning to
 * the instance's own version is always free — it is the state everything else assumes — and
 * confirming a move back would train people to click through the dialog that matters.
 */
export function needsConfirmation(chosen: string, detected: string): boolean {
  return Boolean(detected) && Boolean(chosen) && chosen !== detected;
}

/**
 * What opening a DIFFERENT instance should do.
 *
 * The override is dropped: it was chosen for the folder being left, and carrying it over would
 * answer for an install nobody has open. When the new folder says nothing about itself, the old
 * stored value is the only thing left — kept, but now openly a guess rather than a reading.
 */
export function onInstanceChanged(newDetected: string, stored: string): { value: string; store: string } {
  if (newDetected) return { value: newDetected, store: "" };
  return { value: stored || "", store: stored || "" };
}
