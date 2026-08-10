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
import type { AddonParityRow, ModInfo, ParityRow, ServerSyncRow } from "./types";

/**
 * Must match `parityKey` in electron/headless.ts and in HeadlessView — the headless report is
 * keyed by it, and a key that disagrees would silently pair nothing with anything.
 */
function parityKeyFor(mod: ModInfo): string {
  const id = mod.id.trim().toLowerCase().replace(/\.dll$/, "").replace(/^\d+[-_.\s]+/, "");
  return `${mod.type === "server" ? "server" : "client"}:${id}`;
}

/**
 * Whether a plugin missing from the headless client is a problem or the intended state.
 *
 * Taken from the parity verdict rather than decided here, because that is where the reasoning
 * lives — Fika's own guidance, how SPT loads a mod, and any override the user has set. Copying
 * the judgement would be a second opinion free to disagree with the one on screen.
 */
function headlessGapFor(row: ParityRow | undefined): { gap: "fine" | "needed" | "unknown"; note?: string } {
  if (!row) return { gap: "unknown" };
  const klass = row.verdict.klass;
  if (klass === "required" || klass === "recommended") return { gap: "needed", note: row.verdict.why };
  if (klass === "optional" || klass === "unnecessary" || klass === "server-only") return { gap: "fine", note: row.verdict.why };
  return { gap: "unknown", note: row.verdict.why };
}

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

  /* --- the headless client, on client-plugin slots only ------------------------------
   *
   * A headless client loads BepInEx and nothing else, so server mods and addons can never be on
   * it and comparing them would report every one as missing from a machine that cannot hold it.
   * Prepatchers could live there in principle, but they arrive with their parent plugin, so the
   * plugin is the thing worth reconciling.
   */
  headless?: ModInfo;
  headlessHas?: boolean;
  /**
   * Whether a gap on the headless side MATTERS, which is the whole question for that pane.
   *
   * A headless client deliberately runs a subset: cosmetics, sounds and UI tweaks are pointless
   * on a machine with no screen, and some actively break it. So a missing plugin there is
   * usually correct and occasionally serious, and a blank that cannot tell you which is just a
   * hole in the list.
   */
  headlessGap?: "fine" | "needed" | "unknown";
  /** Why, in the user's words — the verdict's own reasoning, not a restatement of the gap. */
  headlessNote?: string;
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

export function buildAlignedSections(
  rows: ServerSyncRow[],
  localMods: ModInfo[],
  /**
   * The headless client, when one is configured. Folded into the SAME slots rather than given a
   * model of its own, so all three panes walk one list and stay in step — the moment each pane
   * built its own ordering they would drift apart again.
   */
  headless?: { mods: ModInfo[]; parityRows: ParityRow[]; addonRows?: AddonParityRow[] }
): AlignedSection[] {
  const byKey = new Map<string, ModInfo>();
  for (const mod of localMods) byKey.set(localKey(mod), mod);

  const headlessByKey = new Map<string, ModInfo>();
  for (const mod of headless?.mods ?? []) headlessByKey.set(parityKeyFor(mod), mod);
  const parityByKey = new Map<string, ParityRow>();
  for (const row of headless?.parityRows ?? []) parityByKey.set(row.key, row);
  const claimedHeadless = new Set<string>();

  const claimed = new Set<string>();

  /**
   * The headless half of a slot. Client plugins only — a headless client cannot hold a server
   * mod or an addon, so a blank there would report a machine as missing something it is
   * structurally incapable of having.
   */
  const headlessFor = (side: AlignedSide, local: ModInfo | undefined) => {
    if (!headless || side !== "client" || !local) return {};
    const key = parityKeyFor(local);
    const copy = headlessByKey.get(key);
    if (copy) claimedHeadless.add(key);
    const { gap, note } = headlessGapFor(parityByKey.get(key));
    return { headless: copy, headlessHas: Boolean(copy), headlessGap: gap, headlessNote: note };
  };

  /**
   * The headless half of an ADDON slot, from the parity pass's own verdict.
   *
   *   carried-with-parent  its parent is on the headless, so the patch went with it
   *   not-applicable       a server-side patch, which a headless client can never load
   *   parent-missing       the parent is not there, so neither is this
   *   needs-attention      it should be there and is not
   */
  const headlessForAddon = (name: string) => {
    if (!headless?.addonRows) return {};
    const row = headless.addonRows.find((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!row) return {};
    if (row.status === "carried-with-parent") return { headlessHas: true, headlessGap: "fine" as const, headlessNote: row.detail };
    if (row.status === "not-applicable") return { headlessHas: false, headlessGap: "fine" as const, headlessNote: row.detail };
    return { headlessHas: false, headlessGap: "needed" as const, headlessNote: row.detail };
  };

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
        slots.push({
          key: row.key,
          row,
          localAddonVersion: row.localVersion,
          serverHas,
          localHas,
          // Addons DO apply to a headless client — a client-side patch matters wherever its
          // parent plugin runs. The verdict comes from the parity pass, which already worked out
          // whether each addon is carried across, irrelevant, or actually missing there.
          ...(side === "addon" ? headlessForAddon(row.name) : {})
        });
        continue;
      }

      const lookup = side === "server" ? `server:${row.localModId}` : `client:${row.localModId}`;
      const local = row.localModId ? byKey.get(lookup) : undefined;
      if (local) claimed.add(localKey(local));

      slots.push({
        key: row.key,
        row,
        local,
        serverHas,
        localHas: localHas && Boolean(local),
        ...headlessFor(side, local)
      });
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
        slots.push({
          key: `local:${localKey(mod)}`,
          local: mod,
          serverHas: false,
          localHas: true,
          notCompared: true,
          ...headlessFor(side, mod)
        });
      }
    }

    // Plugins the headless client has and the main install does not. Rare and worth seeing: the
    // headless is synced FROM main, so anything here arrived some other way and will not survive
    // the next sync.
    if (side === "client" && headless) {
      for (const mod of headless.mods) {
        const key = parityKeyFor(mod);
        if (claimedHeadless.has(key)) continue;
        claimedHeadless.add(key);
        slots.push({
          key: `headless:${key}`,
          serverHas: false,
          localHas: false,
          headless: mod,
          headlessHas: true,
          headlessGap: "fine"
        });
      }
    }

    return { side, title, hint, slots };
  });

  return sections.filter((s) => s.slots.length > 0);
}
