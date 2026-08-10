/**
 * Lines the main install up against a server, row for row.
 *
 * The two panes used to be independent lists that happened to sit side by side, sorted
 * differently and of different lengths, so nothing on the left corresponded to anything on the
 * right. Reading "what am I missing?" meant finding a name on one side and hunting for it on the
 * other. This produces ONE ordered set of slots that both panes render, so a gap on either side
 * is a blank row rather than a shift that throws every row below it out of step.
 *
 * The pairing is not recomputed here. `buildServerSyncReport` has already done it — properly,
 * with the assembly-GUID and folder-name rules and all the exclusions — and every row carries
 * the `localModId` it settled on. Re-deriving it in the renderer would be a second implementation
 * of the matching, free to disagree with the first.
 *
 * Two states that look alike and are not:
 *
 *   blank + `notCompared: false`  the other side genuinely does not have this.
 *   `notCompared: true`           it was never compared — SPT's own plugin folder, the companion
 *                                 itself. A blank cell there would claim the server lacks SPT.
 */
import type { ModInfo, ServerSyncRow } from "./types";

export type AlignedSide = "client" | "server" | "addon" | "patcher";

export interface AlignedSlot {
  key: string;
  /** The comparison this slot came from. Absent only for local mods that were never compared. */
  row?: ServerSyncRow;
  /** The local half, for the client and server sections. */
  local?: ModInfo;
  /**
   * Addons have no ModInfo — most unpack into their parent and own no folder, so they exist
   * only in the ledger. The local half of an addon slot is therefore just its recorded version.
   */
  localAddonVersion?: string;
  /** Whether each pane has anything to draw. The other one draws a blank of the same height. */
  serverHas: boolean;
  localHas: boolean;
  /** Deliberately outside the comparison. Neither side may be read as missing it. */
  notCompared?: boolean;
}

export interface AlignedSection {
  side: AlignedSide;
  title: string;
  hint: string;
  slots: AlignedSlot[];
}

/** In the order the local pane already lists them, so the two panes can be read across. */
const SECTIONS: { side: AlignedSide; title: string; hint: string }[] = [
  { side: "client", title: "Client plugins", hint: "BepInEx/plugins" },
  { side: "server", title: "Server mods", hint: "user/mods" },
  { side: "patcher", title: "Prepatchers", hint: "BepInEx/patchers" },
  { side: "addon", title: "Addons", hint: "patches, from install records" }
];

const localKey = (mod: ModInfo) => `${mod.type === "server" ? "server" : "client"}:${mod.id}`;

export function buildAlignedSections(rows: ServerSyncRow[], localMods: ModInfo[]): AlignedSection[] {
  const byKey = new Map<string, ModInfo>();
  for (const mod of localMods) byKey.set(localKey(mod), mod);

  const claimed = new Set<string>();

  const sections = SECTIONS.map(({ side, title, hint }) => {
    const slots: AlignedSlot[] = [];

    for (const row of rows) {
      if ((row.side ?? "server") !== side) continue;

      // The two issues that ARE a gap, one each way. Everything else exists on both sides and
      // differs only in version, so both cells are drawn.
      const serverHas = row.issue !== "not-on-server";
      const localHas = row.issue !== "missing-locally";

      // Neither addons nor prepatchers are mods, so neither has a ModInfo to pair with. An addon
      // owns no folder at all; a patcher owns a file but is folded into its parent by the scanner
      // and never listed on its own. Both are described entirely by the row itself.
      if (side === "addon" || side === "patcher") {
        slots.push({ key: row.key, row, localAddonVersion: row.localVersion, serverHas, localHas });
        continue;
      }

      const lookup = side === "server" ? `server:${row.localModId}` : `client:${row.localModId}`;
      const local = row.localModId ? byKey.get(lookup) : undefined;
      if (local) claimed.add(localKey(local));

      slots.push({ key: row.key, row, local, serverHas, localHas: localHas && Boolean(local) });
    }

    // Local mods this section covers that no row referred to. They are not differences — they
    // were held out of the comparison on purpose (SPT's own files, the companion this app
    // installs) — so they are shown with the far side marked "not compared" rather than blank.
    if (side !== "addon" && side !== "patcher") {
      for (const mod of localMods) {
        const isServer = mod.type === "server";
        if ((side === "server") !== isServer) continue;
        if (claimed.has(localKey(mod))) continue;
        claimed.add(localKey(mod));
        slots.push({ key: `local:${localKey(mod)}`, local: mod, serverHas: false, localHas: true, notCompared: true });
      }
    }

    return { side, title, hint, slots };
  });

  return sections.filter((s) => s.slots.length > 0);
}
