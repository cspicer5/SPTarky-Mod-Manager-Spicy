/**
 * What pressing the button in the browse list would actually DO.
 *
 * "Install" on a mod you already have, at the version you already have, is a lie by omission:
 * it reads as "you don't have this" and hides that the button will overwrite. Naming the real
 * action also makes an accidental DOWNGRADE visible before it happens, which is the expensive
 * mistake here — in a version dropdown, an older build looks exactly like a newer one.
 *
 * Kept in its own module, free of React and DOM, so it can be tested directly. The rest of
 * the browse pane cannot be, and this is the part where being wrong costs the user a
 * reinstall at the wrong version.
 */
import { ModInfo } from "./types";

export type BrowseInstallState =
  | { kind: "install" }
  | { kind: "reinstall"; installedVersion: string }
  | { kind: "upgrade"; installedVersion: string }
  | { kind: "downgrade"; installedVersion: string }
  | { kind: "installed-unknown" };

/**
 * Numeric semver comparison, so 0.10.0 sorts above 0.9.0 as it should.
 *
 * Tolerates a leading "v" and any number of parts, because published versions are not
 * disciplined: "v1.2", "1.2.0.0" and "1.2.0" all turn up and all mean the same thing.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function browseInstallState(installed: ModInfo[] | undefined, selectedVersion?: string): BrowseInstallState {
  if (!installed || installed.length === 0) return { kind: "install" };

  // A mod's halves share a version; prefer a RECORDED one — what the app actually installed,
  // with the files unchanged since — over what the mod declares about itself. Several authors
  // never update their declaration (Fika's server mod says 2.0.9 whatever you have), so
  // trusting the declaration would report a phantom upgrade forever.
  const recorded = installed.find((m) => m.versionSource === "recorded" && m.version);
  const current = (recorded ?? installed.find((m) => m.version))?.version;

  // Installed, but with nothing trustworthy to compare. Saying so beats guessing a direction:
  // a wrong "Upgrade" here is precisely the silent mislabel this function exists to prevent.
  if (!current || !selectedVersion) return { kind: "installed-unknown" };

  const diff = compareSemver(selectedVersion, current);
  if (diff === 0) return { kind: "reinstall", installedVersion: current };
  return diff > 0 ? { kind: "upgrade", installedVersion: current } : { kind: "downgrade", installedVersion: current };
}
