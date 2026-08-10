/**
 * The multi-instance view: the main install, a live SPT server, and a Fika headless client,
 * side by side with the reconciliation between them.
 *
 * The three panes are deliberately NOT symmetrical, and the asymmetry is the point:
 *
 *   main      a full SPT install — client plugins AND server mods. Read/write.
 *   server    a running server somewhere on the network. It can only report the server mods
 *             it has LOADED, so no client plugins appear here and nothing is writable.
 *   headless  a Fika headless client. Being a client, it loads BepInEx/ only, so it can
 *             never hold server mods. Read/write.
 *
 * Rendering them as mirror images would report every server mod as "missing" from the
 * headless client and every client plugin as "missing" from the server, when in both cases
 * the mod cannot exist there at all. Each pane states its own scope under its title.
 *
 * Strings are literal rather than routed through i18n: this fork is English-only by design,
 * so the i18n layer is a pass-through and keys would add indirection without a language.
 */
import { useState } from "react";
import {
  HeadlessClass,
  HeadlessVerdict,
  ModInfo,
  ParityReport,
  ParityRow,
  ServerSyncReport,
  ServerSyncRow,
  CompanionInstallState
} from "./types";
import { buildAlignedSections, type AlignedSection, type AlignedSlot } from "./serverAlignment";
import "./headless.css";

/**
 * Must stay identical to parityKey() in electron/headless.ts. Scoping by side is what stops
 * a mod that ships a server half and a client half under one folder name (several do) from
 * collapsing into a single row, where one half inherits the other's verdict.
 */
function parityKey(mod: ModInfo): string {
  return `${mod.type === "server" ? "server" : "client"}:${mod.id.trim().toLowerCase().replace(/\.dll$/, "").replace(/^\d+[-_.\s]+/, "")}`;
}

const CLASS_LABEL: Record<HeadlessClass, string> = {
  required: "Required",
  recommended: "Recommended",
  optional: "Optional",
  unnecessary: "Not needed",
  unknown: "Undecided",
  "server-only": "Server only"
};

/** What the verdict rests on, in the user's words. A guess must read as a guess. */
const SOURCE_LABEL: Record<string, string> = {
  manual: "your choice",
  structural: "how SPT loads mods",
  rule: "Fika's guidance",
  pairing: "server half installed",
  category: "guessed from category",
  none: "no guidance"
};

const ISSUE_LABEL: Record<string, string> = {
  "missing-required": "Missing — required",
  "version-drift": "Version mismatch",
  "missing-recommended": "Missing on headless",
  "server-mod-in-headless": "Never loads here",
  "unnecessary-menu-risk": "Patches menus",
  "headless-only": "Only on headless"
};

/**
 * Labels state the CONDITION, not the action.
 *
 * "Install this" sat directly beside a button already saying "Install", which read as two
 * controls for one thing. The tag's job is to say what is wrong; the button says what to do
 * about it, and on rows that cannot be fetched there is no button at all — so an action-worded
 * tag was telling people to press something that was not there.
 */
const SERVER_ISSUE_LABEL: Record<string, string> = {
  "missing-locally": "Missing here",
  "outdated-locally": "Behind server",
  "newer-locally": "Newer here",
  "not-on-server": "Not on server",
  "unknown-local-version": "Can't compare"
};

/**
 * The three halves of an install, in the order the local pane lists them, so the two panes can
 * be read across. Addons come last because they are the only ones with no folder of their own —
 * they live inside their parent and exist, as far as anything can tell, only in the ledger.
 */
const SERVER_SECTIONS: { side: "client" | "server" | "addon"; title: string; hint: string }[] = [
  { side: "client", title: "Client plugins", hint: "BepInEx/plugins" },
  { side: "server", title: "Server mods", hint: "user/mods" },
  { side: "addon", title: "Addons", hint: "patches, from install records" }
];

/**
 * A placeholder holding one side's place while the other has something.
 *
 * It is the whole point of the aligned view: without it a gap shifts every row below it, so the
 * two panes agree at the top and drift further apart the longer the list. Same height as a real
 * row, and it says WHICH kind of nothing it is — "not installed here" is a difference to act on,
 * "not compared" is a row deliberately held out (SPT's own files, the companion) and is not.
 */
function BlankRow({ reason }: { reason: string }) {
  return (
    <li className={`hl-row hl-row-blank ${reason === "not compared" ? "hl-row-uncompared" : ""}`} aria-hidden="true">
      <span className="hl-blank-mark">{reason}</span>
    </li>
  );
}

function VerdictBadge({ verdict }: { verdict: HeadlessVerdict }) {
  return (
    <span
      className={`hl-badge hl-${verdict.klass}`}
      title={`${verdict.why}\n\nBasis: ${SOURCE_LABEL[verdict.source] ?? verdict.source}`}
    >
      {CLASS_LABEL[verdict.klass]}
      {/* Anything weaker than a documented rule is marked, so an inference never reads as a
          fact. Same principle as the Forge matcher's "needs confirmation". */}
      {(verdict.source === "category" || verdict.source === "none") && <em className="hl-guess">?</em>}
    </span>
  );
}

function OverrideMenu({
  value,
  onChange
}: {
  value: HeadlessClass | undefined;
  onChange: (klass: HeadlessClass | null) => void;
}) {
  return (
    <select
      className="hl-override"
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as HeadlessClass | null)}
      title="Override this classification. Your choice outranks every rule."
    >
      <option value="">Auto</option>
      <option value="required">Required</option>
      <option value="recommended">Recommended</option>
      <option value="optional">Optional</option>
      <option value="unnecessary">Not needed</option>
    </select>
  );
}

/** Chrome shared by every pane, so collapsing behaves identically across all three. */
function PaneShell({
  title,
  subtitle,
  location,
  count,
  collapsed,
  onToggleCollapse,
  headerExtra,
  aligned,
  children
}: {
  title: string;
  subtitle: string;
  location: string | null;
  count: number | string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  headerExtra?: React.ReactNode;
  /**
   * Reserve the SAME height above the list in every pane.
   *
   * Equal row heights are not enough to line two panes up — the lists have to START level too,
   * and the server pane carries a readiness box and a row of counts that the main pane does not.
   * That offset every row below it by a constant, which is exactly what "the rows aren't lined
   * up" looked like: correct order, correct blanks, uniformly shifted.
   *
   * A fixed height rather than a minimum, because a minimum lets the taller pane grow and puts
   * the offset straight back.
   */
  aligned?: boolean;
  children: React.ReactNode;
}) {
  if (collapsed) {
    return (
      <button className="hl-pane hl-pane-collapsed" onClick={onToggleCollapse} title={`Expand ${title}`}>
        <span className="hl-collapsed-title">{title}</span>
        <span className="hl-collapsed-count">{count}</span>
        <span className="hl-collapsed-hint">▸</span>
      </button>
    );
  }
  return (
    <div className="hl-pane">
      <div className="hl-pane-header">
        <div>
          <h2>
            <button className="hl-collapse-btn" onClick={onToggleCollapse} title={`Collapse ${title}`}>
              ▾
            </button>
            {title}
          </h2>
          <span className="hl-pane-sub">{subtitle}</span>
        </div>
        <span className="hl-pane-count">{count}</span>
      </div>
      <div className="hl-pane-path" title={location ?? ""}>
        {location ?? "Not configured"}
      </div>
      {/* Always rendered, even when empty, so every pane reserves the same block and the lists
          below them begin on the same line. */}
      <div className={`hl-pane-extra${aligned ? " hl-pane-extra-fixed" : ""}`}>{headerExtra}</div>
      {children}
    </div>
  );
}

function InstancePane({
  title,
  subtitle,
  path,
  mods,
  rowsByKey,
  overrides,
  onOverride,
  onToggle,
  onUninstall,
  onOpenFolder,
  emptyMessage,
  showVerdicts,
  collapsed,
  onToggleCollapse,
  filtersActive,
  onSyncMod,
  syncing,
  canSync,
  alignedSections
}: {
  title: string;
  subtitle: string;
  path: string | null;
  mods: ModInfo[];
  /**
   * When a server is connected, both panes render THIS instead of their own grouping, so row N
   * on the left is row N on the right and a gap shows as a blank rather than shifting
   * everything below it out of step.
   */
  alignedSections?: AlignedSection[];
  rowsByKey: Map<string, ParityRow>;
  overrides: Record<string, HeadlessClass>;
  onOverride: (key: string, klass: HeadlessClass | null) => void;
  onToggle: (mod: ModInfo) => void;
  onUninstall: (mod: ModInfo) => void;
  onOpenFolder: (mod: ModInfo) => void;
  emptyMessage: string;
  showVerdicts: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  filtersActive: boolean;
  /** Copy this plugin to the headless client. Only offered where it would change something. */
  onSyncMod?: (mod: ModInfo) => void;
  syncing?: boolean;
  canSync?: boolean;
}) {
  const servers = mods.filter((m) => m.type === "server");
  const clients = mods.filter((m) => m.type !== "server");

  const renderRow = (mod: ModInfo, slot?: AlignedSlot) => {
    const row = rowsByKey.get(parityKey(mod));
    const issue = row?.issue;
    return (
      <li
        key={slot?.key ?? `${mod.type}:${mod.id}`}
        className={`hl-row ${mod.enabled ? "" : "disabled"} ${issue ? `hl-issue-${issue}` : ""}`}
      >
        {/* Actions live on the title line, not with the badges. When they shared a row with
            a badge plus an issue tag plus the override select, the group wrapped and rows
            with problems became twice as tall as rows without — the list read as ragged
            exactly where it most needed to be scannable. */}
        <div className="hl-row-main">
          <span className="hl-name" title={mod.id}>
            {mod.name}
          </span>
          <span className="hl-version">{mod.version ?? "—"}</span>
          <div className="hl-row-actions">
            {/* Offered only where copying would actually change something — on a row that
                is missing from the headless client or has drifted out of version with it.
                A copy button on an already-matching row invites pointless overwrites. */}
            {canSync &&
              onSyncMod &&
              mod.type !== "server" &&
              (issue === "missing-required" || issue === "missing-recommended" || issue === "version-drift") && (
                <button
                  className="hl-sync-btn"
                  onClick={() => onSyncMod(mod)}
                  disabled={syncing}
                  title={
                    issue === "version-drift"
                      ? `Copy ${mod.version ?? "this version"} over the headless client's copy`
                      : "Copy this plugin to the headless client"
                  }
                >
                  →
                </button>
              )}
            <button onClick={() => onToggle(mod)} title={mod.enabled ? "Disable" : "Enable"}>
              {mod.enabled ? "On" : "Off"}
            </button>
            <button onClick={() => onOpenFolder(mod)} title="Open folder">
              ⁝
            </button>
            <button onClick={() => onUninstall(mod)} title="Remove" className="hl-danger">
              ✕
            </button>
          </div>
        </div>
        <div className="hl-row-meta">
          {showVerdicts && row && <VerdictBadge verdict={row.verdict} />}
          {issue && (
            <span className={`hl-issue hl-issue-tag-${issue}`} title={row?.detail ?? ""}>
              {ISSUE_LABEL[issue] ?? issue}
            </span>
          )}
          {/* The server-side verdict belongs on whichever pane HAS the files. When the server
              does not have this at all its own row is blank, so the tag would otherwise have
              nowhere to live and the difference would be invisible from either side. */}
          {slot?.row?.issue === "not-on-server" && (
            <span className="hl-issue hl-issue-tag-server-not-on-server" title={slot.row.detail ?? ""}>
              Not on server
            </span>
          )}
          {/* Overrides are keyed by the mod, not the side: saying "SAIN is required" is a
              statement about SAIN, and the backend looks it up by plain name. */}
          {showVerdicts && row && row.verdict.klass !== "server-only" && (
            <OverrideMenu value={overrides[row.modKey]} onChange={(klass) => onOverride(row.modKey, klass)} />
          )}
        </div>
      </li>
    );
  };

  return (
    <PaneShell
      title={title}
      subtitle={subtitle}
      location={path}
      count={mods.length}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      aligned={!!alignedSections}
      headerExtra={
        alignedSections ? (
          /* The counterpart to the server's readiness box. It fills the reserved block with
             something worth reading rather than blank space, and being the same markup it is
             the same height, which is what keeps the two lists starting on the same line. */
          <>
            <div className="hl-server-status">
              <strong>This PC</strong>
              <span>{mods.length} installed</span>
            </div>
            <ul className="hl-server-counts">
              {alignedSections.map((s) => (
                <li key={s.side}>
                  {s.slots.filter((slot) => slot.localHas).length} {s.side === "addon" ? "addons" : s.side}
                </li>
              ))}
            </ul>
          </>
        ) : undefined
      }
    >
      {mods.length === 0 ? (
        <p className="empty-list">{filtersActive ? "Nothing here matches the current filters." : emptyMessage}</p>
      ) : alignedSections ? (
        /* Lined up against the server pane. Same sections, same order, same number of rows —
           a slot the server has and this install does not is a blank of equal height, so the
           two lists stay in step all the way down instead of drifting apart at the first gap. */
        <div className="hl-pane-body hl-aligned">
          {alignedSections.map((section) => (
            <section key={section.side} className={`hl-section hl-section-${section.side}`}>
              <h3 className="hl-group-title">
                {section.title} <span>{section.hint}</span> ({section.slots.filter((s) => s.localHas).length})
              </h3>
              <ul className="hl-list">
                {section.slots.map((slot) =>
                  slot.local && slot.localHas ? (
                    renderRow(slot.local, slot)
                  ) : slot.localHas ? (
                    /* An addon: real, installed, but with no folder of its own to act on. */
                    <li key={slot.key} className="hl-row hl-row-addon">
                      <div className="hl-row-main">
                        <span className="hl-name" title={slot.row?.parentName ? `Patches ${slot.row.parentName}` : ""}>
                          {slot.row?.name}
                        </span>
                        <span className="hl-version">{slot.localAddonVersion ?? "—"}</span>
                      </div>
                      <div className="hl-row-meta" />
                    </li>
                  ) : (
                    <BlankRow key={slot.key} reason={slot.notCompared ? "not compared" : "not installed here"} />
                  )
                )}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="hl-pane-body">
          <h3 className="hl-group-title">
            Client plugins <span>BepInEx/plugins</span> ({clients.length})
          </h3>
          <ul className="hl-list">{clients.map((m) => renderRow(m))}</ul>

          {servers.length > 0 && (
            <>
              <h3 className="hl-group-title">
                Server mods <span>user/mods</span> ({servers.length})
              </h3>
              <ul className="hl-list">{servers.map((m) => renderRow(m))}</ul>
            </>
          )}
        </div>
      )}
    </PaneShell>
  );
}

/**
 * The live server. Read-only, and visibly so — no toggle, no remove, no override. What it
 * shows is not "the server's mod folder" but "the mods the server has loaded", which is the
 * only thing it can report about itself.
 */
function ServerPane({
  report,
  url,
  collapsed,
  onToggleCollapse,
  onChangeServer,
  onClearServer,
  onLockToServer,
  companion,
  onInstallCompanion,
  query,
  onInstall,
  installing,
  alignedSections
}: {
  report: ServerSyncReport | null;
  url: string | null;
  /** The shared row model. Both panes walk it in step; see serverAlignment.ts. */
  alignedSections?: AlignedSection[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChangeServer: () => void;
  onClearServer: () => void;
  /** Match the app's SPT version to the one this server runs. */
  onLockToServer: () => void;
  /** The companion in the LOCAL instance — what installing would do here. */
  companion: CompanionInstallState | null;
  onInstallCompanion: () => void;
  query: string;
  /** Fetch this mod from Forge into the MAIN install. The server itself is never written to. */
  onInstall: (row: ServerSyncRow) => void;
  installing: string | null;
}) {
  if (!url) {
    return (
      <PaneShell
        title="Server"
        subtitle="Remote — not connected"
        location={null}
        count="—"
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
      >
        <p className="empty-list">
          Connect to a running SPT server to see which mods it loads and what you are missing.
        </p>
        <div className="hl-pane-actions">
          <button onClick={onChangeServer} className="primary">
            Connect to a server
          </button>
        </div>
      </PaneShell>
    );
  }

  if (report && !report.reachable) {
    return (
      <PaneShell
        title="Server"
        subtitle="Unreachable"
        location={url}
        count="—"
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
      >
        <p className="hl-server-error">{report.error}</p>
        <div className="hl-pane-actions">
          <button onClick={onChangeServer}>Change address</button>
          <button onClick={onClearServer}>Disconnect</button>
        </div>
      </PaneShell>
    );
  }

  // Filtering happens ONCE, in HeadlessView, and the same filtered slots reach both panes —
  // filtering here as well would let the two lists disagree on which rows exist, which is
  // precisely the drift the aligned model exists to prevent.
  const sections = alignedSections ?? [];

  // The pane counts what the SERVER runs, not the number of rows. Rows also include local
  // mods the server does not load ("not on server"), and folding those into the headline
  // number made a 25-mod server read as 32.
  const serverModCount = (report?.rows ?? []).filter((r) => r.issue !== "not-on-server").length;

  /*
   * Names that appear on more than one side.
   *
   * A mod commonly ships BOTH halves under the same folder name — `acidphantasm-botplacementsystem`
   * exists in `user/mods` AND in `BepInEx/plugins`, and so do ManimalIcebreaker, WTT-PackNStrap and
   * Show Me The Money. Both rows are real, both are compared separately, and they can drift apart
   * independently, so neither may be dropped. The sections already show which half is which; this
   * only adds a line to the TOOLTIP so a name seen twice explains itself.
   */
  const sharedNames = new Set<string>();
  const seenBySide = new Map<string, string>();
  for (const row of report?.rows ?? []) {
    const name = row.name.trim().toLowerCase();
    const side = row.side ?? "server";
    const other = seenBySide.get(name);
    if (other !== undefined && other !== side) sharedNames.add(name);
    else if (other === undefined) seenBySide.set(name, side);
  }

  const renderRow = (row: ServerSyncRow) => (
    <li key={row.key} className={`hl-row ${row.issue ? `hl-issue-server-${row.issue}` : ""}`}>
      <div className="hl-row-main">
        <span
          className="hl-name"
          title={[
            row.guid && `GUID: ${row.guid}`,
            row.serverName && `Server calls it: ${row.serverName}`,
            row.parentName && `Patches: ${row.parentName}`,
            // Said once, on the name, now that the sections themselves show which half is which.
            sharedNames.has(row.name.trim().toLowerCase()) &&
              "This mod ships BOTH halves under one name — it appears in the other section too. Different files, and they can differ in version."
          ]
            .filter(Boolean)
            .join("\n")}
        >
          {row.name}
        </span>
        {/* A "not on server" row has no server version by definition, and printing "—" hid the
            one version that DOES exist. Showing the local one answers "what have I got, then?"
            without a second glance at the pane on the left. */}
        {row.issue === "not-on-server" ? (
          <span className="hl-version hl-version-local" title="Your version. The server does not have this at all.">
            {row.localVersion ?? "—"}
          </span>
        ) : (
          <span className="hl-version">{row.serverVersion ?? "—"}</span>
        )}
        {/* Offered only where it would change something: a mod the server runs that is
            absent or older here. It installs into the MAIN install — never the server,
            which is read only, and never the headless client, which is synced from main so
            the two can never disagree on a version.

            `installable === false` withholds it where the fetch could not be done correctly —
            a client plugin with no ID, an addon that never came from the catalogue. The row
            says why in its place, because a button that quietly installs the wrong mod is far
            worse than one that is not there. */}
        {(row.issue === "missing-locally" || row.issue === "outdated-locally") &&
          (row.installable === false ? (
            <span className="hl-cannot-install" title={row.notInstallableReason ?? ""}>
              by hand
            </span>
          ) : (
            <button
              className="hl-install-btn"
              onClick={() => onInstall(row)}
              disabled={installing !== null}
              title={
                row.issue === "outdated-locally"
                  ? `Get ${row.serverVersion} from the catalogue and install it here`
                  : "Find this in the catalogue and install it into the main install"
              }
            >
              {installing === row.key ? "…" : row.issue === "outdated-locally" ? "Update" : "Install"}
            </button>
          ))}
      </div>
      <div className="hl-row-meta">
        {/* No side badge here. The section a row sits in already says which half it is, and
            repeating that on all 71 rows was the "messy" part rather than a cure for it. */}
        {row.issue && (
          <span className={`hl-issue hl-issue-tag-server-${row.issue}`} title={row.detail ?? ""}>
            {SERVER_ISSUE_LABEL[row.issue] ?? row.issue}
          </span>
        )}
        {/* Shown only when the versions genuinely DIFFER, which is what the issue says.
            This used to be a raw string inequality, and "5.3.11.0" is not the string "5.3.11"
            — so Tyfon.UIFixes.Net printed "you 5.3.11.0 → 5.3.11" on a row the comparison had
            already, correctly, called identical. The report compares numerically; trusting its
            verdict here keeps one set of version semantics instead of a second one that
            disagrees. */}
        {(row.issue === "outdated-locally" || row.issue === "newer-locally") && row.localVersion && row.serverVersion && (
          <span className="hl-server-versions">
            you {row.localVersion} → {row.serverVersion}
          </span>
        )}
        {/* A name match is weaker than a GUID match and says so, rather than being presented
            with the same confidence. `package` sits between the two: the name lined up AND both
            machines' install records name the same catalogue entry, which is corroboration
            rather than a guess — so it gets no question mark. Tyfon.UIFixes.Net is the case
            that forced the distinction: it declares no GUID at all and can only ever match by
            name, but both ledgers agree on the package it came from. */}
        {row.matchedBy === "name" && (
          <span className="hl-badge hl-unknown" title="Matched by name alone, with nothing to corroborate it — worth confirming.">
            name match<em className="hl-guess">?</em>
          </span>
        )}
        {row.matchedBy === "package" && (
          <span
            className="hl-badge hl-matched-package"
            title="Matched by name, and both machines' install records say it came from the same catalogue package. This plugin declares no GUID of its own, so that is the strongest evidence available."
          >
            same package
          </span>
        )}
        {row.url && (
          <a className="hl-server-src" href={row.url} target="_blank" rel="noreferrer" title={row.url}>
            source
          </a>
        )}
      </div>
    </li>
  );

  const counts = report?.counts;

  return (
    <PaneShell
      title="Server"
      // Says what is actually being compared. Without a companion that really is only the
      // loaded server mods; with one it is the whole install, and leaving the old wording in
      // place made the headline number look wrong rather than broader.
      subtitle={
        sections.some((s) => s.side !== "server")
          ? "Remote — server mods, client plugins and addons, read only"
          : "Remote — loaded server mods, read only"
      }
      location={url}
      count={report ? serverModCount : "…"}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      aligned={sections.length > 0}
      headerExtra={
        report ? (
          <>
            <div className={`hl-server-status ${report.readyToPlay ? "ok" : "warn"}`}>
              <strong>{report.readyToPlay ? "Ready to play" : "Not ready"}</strong>
              <span>
                SPT {report.sptVersion ?? "?"}
                {report.sptMatches === false && <em className="hl-spt-mismatch"> ≠ yours ({report.localSptVersion})</em>}
              </span>
            </div>
            {/* Moved up out of the body. Everything above the list has to live in the reserved
                block, or it pushes the list down and the panes stop lining up. */}
            {counts && (
              <ul className="hl-server-counts">
                {counts.needInstalling > 0 && <li className="bad">{counts.needInstalling} to install</li>}
                {counts.needUpdating > 0 && <li className="bad">{counts.needUpdating} to update</li>}
                {counts.unknownVersion > 0 && <li>{counts.unknownVersion} can't compare</li>}
                {counts.newerLocally > 0 && <li className="warn">{counts.newerLocally} newer here</li>}
                {counts.notOnServer > 0 && <li className="warn">{counts.notOnServer} not on server</li>}
                <li className="ok">{counts.inSync} in sync</li>
              </ul>
            )}
          </>
        ) : undefined
      }
    >
      {sections.length === 0 ? (
        <p className="empty-list">{query ? "Nothing here matches the search." : "No server mods reported."}</p>
      ) : (
        <div className="hl-pane-body hl-aligned">
          {/*
           * Split by half, in the SAME ORDER as the local pane beside it — client plugins, then
           * server mods, then addons. Three kinds in one flat list was genuinely hard to read: a
           * mod that ships both halves appears twice by necessity, and with nothing separating
           * them it looked like the report was repeating itself. Sections make that self-evident
           * and let each half be counted against the equivalent section on the left.
           *
           * Each section is tinted, very faintly, so the boundary is visible while scrolling
           * without the colour becoming a signal in its own right — the issue tags are what
           * should catch the eye, not the background.
           */}
          {(alignedSections ?? []).map((section) => (
            <section key={section.side} className={`hl-section hl-section-${section.side}`}>
              <h3 className="hl-group-title">
                {section.title} <span>{section.hint}</span> ({section.slots.filter((s) => s.serverHas).length})
              </h3>
              <ul className="hl-list">
                {section.slots.map((slot) =>
                  slot.serverHas && slot.row ? (
                    renderRow(slot.row)
                  ) : (
                    <BlankRow key={slot.key} reason={slot.notCompared ? "not compared" : "not on server"} />
                  )
                )}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* The companion, and what its absence costs. Stated as a limit on what can be KNOWN —
          never as a finding about the server's mods, because a server that cannot be asked and
          a server with nothing to report must not read the same. */}
      {report && (
        <p className="hl-gutter-note">
          {report.companionPresent ? (
            <>
              <strong>Companion {report.companionVersion ?? ""} connected.</strong> Versions above are what is really
              installed, read from that machine's own records.
              {report.serverClientMods && ` Its ${report.serverClientMods.length} client plugins are visible too.`}
              {/* Said explicitly, because "no addon differences" and "addons were not compared"
                  look identical in a list and mean opposite things. Addons usually unpack into
                  their parent's folder, so there is nothing on disk to notice their absence. */}
              {report.addonsCompared === false &&
                " Addons were not compared — one of the two machines has no addon records, and addons leave nothing on disk to check for."}
            </>
          ) : (
            <>
              {report.companionReason ?? "This server has no SPTarky companion."} Without it, versions are only what
              each mod declares about itself — some authors never update theirs — and the server's client plugins
              cannot be read at all.
              {companion?.canInstall && !companion.installed && " If this server is this PC, install it from the header."}
              {companion?.installed && " It is installed on this PC — if that is this server, restart it to load the companion."}
            </>
          )}
        </p>
      )}

      {/* No install button here on purpose. Installing writes to the LOCAL instance, and a
          button inside the pane describing a REMOTE server would read as acting on that
          server. The single control lives in the header, next to the instance path it
          actually writes to. */}

      {report && report.fikaRequired.length === 0 && (
        <p className="hl-gutter-note">
          This server declares no required client plugins, so client-side parity cannot be checked against it. The host
          sets that in <code>fika.jsonc</code> under <code>client.mods.required</code>.
        </p>
      )}

      <div className="hl-pane-actions">
        {/* Offered only when it would change something. A server whose SPT already matches
            needs no button, and one that never reported a version has nothing to lock to —
            in both cases an enabled button would be a promise the press cannot keep. */}
        {report?.sptVersion && report.sptMatches === false && (
          <button
            className="primary"
            onClick={onLockToServer}
            title={`Browse and install against SPT ${report.sptVersion}, the version this server runs`}
          >
            Lock to server (SPT {report.sptVersion})
          </button>
        )}
        <button onClick={onChangeServer}>Change address</button>
        <button onClick={onClearServer}>Disconnect</button>
      </div>
    </PaneShell>
  );
}

/** The break down the middle: what the two local instances do and do not agree on. */
function ParityGutter({ parity }: { parity: ParityReport | null }) {
  if (!parity) {
    return (
      <div className="hl-gutter">
        <div className="hl-gutter-title">Parity</div>
        <p className="hl-gutter-note">Link a headless client to compare it against the main install.</p>
      </div>
    );
  }

  const { counts } = parity;
  const problems = parity.rows.filter((r) => r.issue && r.issue !== "headless-only");

  return (
    <div className="hl-gutter">
      <div className="hl-gutter-title">Parity</div>

      <ul className="hl-gutter-counts">
        <li className={counts.aligned ? "ok" : ""}>
          <strong>{counts.aligned}</strong> aligned
        </li>
        <li className={counts.missingOnHeadless ? "warn" : ""}>
          <strong>{counts.missingOnHeadless}</strong> missing
        </li>
        <li className={counts.versionDrift ? "bad" : ""}>
          <strong>{counts.versionDrift}</strong> drift
        </li>
        <li className={counts.headlessOnly ? "warn" : ""}>
          <strong>{counts.headlessOnly}</strong> extra
        </li>
        <li>
          <strong>{counts.needsReview}</strong> to review
        </li>
      </ul>

      {/* Compatibility patches, which the plugin rows above cannot show: most live inside
          their parent's folder, so the parent's row looks the same whether the patch is
          there or not. A patch missing on one side breaks the pair it reconciles, and shows
          up as a desync rather than as a missing mod. */}
      {parity?.addons && parity.addons.length > 0 && (
        <div className="hl-gutter-addons">
          <div className="hl-gutter-title">Compatibility addons</div>
          <ul>
            {parity.addons.map((a) => (
              <li key={`${a.name}:${a.parentName}`} className={`hl-addon-${a.status}`}>
                <span className="hl-addon-name">{a.name}</span>
                <span className="hl-addon-status">
                  {a.status === "carried-with-parent"
                    ? "on both"
                    : a.status === "not-applicable"
                      ? "server-side"
                      : a.status === "parent-missing"
                        ? "sync parent"
                        : "check"}
                </span>
                <span className="hl-addon-detail">{a.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {problems.length === 0 ? (
        <p className="hl-gutter-clear">
          Nothing to reconcile. Every mod that changes raid behaviour is present on both sides at the same version.
        </p>
      ) : (
        <ol className="hl-gutter-list">
          {problems.slice(0, 12).map((row) => (
            <li key={row.key} className={`hl-gutter-item hl-issue-tag-${row.issue}`} title={row.detail ?? ""}>
              <span className="hl-gutter-issue">{ISSUE_LABEL[row.issue!] ?? row.issue}</span>
              <span className="hl-gutter-name">{row.name}</span>
              {row.issue === "version-drift" && (
                <span className="hl-gutter-versions">
                  {row.mainVersion} → {row.headlessVersion}
                </span>
              )}
            </li>
          ))}
          {problems.length > 12 && <li className="hl-gutter-more">+{problems.length - 12} more</li>}
        </ol>
      )}

      <p className="hl-gutter-note">
        The headless client is the raid host and is authoritative on AI and inventory, so anything that changes in-raid
        behaviour must match on both sides. Display-only and stash-only mods do not need to.
      </p>
    </div>
  );
}

export default function InstancesView({
  mainPath,
  headlessPath,
  mainMods,
  headlessMods,
  parity,
  server,
  serverUrl,
  filtersActive,
  overrides,
  onOverride,
  onToggle,
  onUninstall,
  onOpenFolder,
  onChangeHeadless,
  onChangeServer,
  onClearServer,
  onLockToServer,
  companion,
  onInstallCompanion,
  onExitMultiMode,
  onRefresh,
  refreshing,
  searchQuery,
  onSyncMod,
  onSyncAll,
  onRemoveFromHeadless,
  syncing,
  headlessConfigured,
  onInstallFromServer,
  installingFromServer,
  onSyncBundles,
  bundleLabel,
  bundleTitle,
  bundleBusy,
  bundleOutOfSync,
  onSyncAllFromServer,
  syncingAllFromServer
}: {
  mainPath: string | null;
  headlessPath: string | null;
  mainMods: ModInfo[];
  headlessMods: ModInfo[];
  parity: ParityReport | null;
  server: ServerSyncReport | null;
  serverUrl: string | null;
  filtersActive: boolean;
  overrides: Record<string, HeadlessClass>;
  onOverride: (key: string, klass: HeadlessClass | null) => void;
  onToggle: (mod: ModInfo, target: "main" | "headless") => void;
  onUninstall: (mod: ModInfo, target: "main" | "headless") => void;
  onOpenFolder: (mod: ModInfo, target: "main" | "headless") => void;
  onChangeHeadless: () => void;
  onChangeServer: () => void;
  onClearServer: () => void;
  /** Match the app's SPT version to the one the connected server runs. */
  onLockToServer: () => void;
  companion: CompanionInstallState | null;
  onInstallCompanion: () => void;
  onExitMultiMode: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** The shared search box. Applied to the server pane too — it has its own row shape, so
      it cannot go through applyFilterSort with the local panes. */
  searchQuery: string;
  onSyncMod: (mod: ModInfo) => void;
  onSyncAll: () => void;
  onRemoveFromHeadless: (mod: ModInfo) => void;
  syncing: boolean;
  headlessConfigured: boolean;
  onInstallFromServer: (row: ServerSyncRow) => void;
  installingFromServer: string | null;
  /** Bundle sync — see the toolbar button. Only meaningful with a server configured. */
  onSyncBundles: () => void;
  bundleLabel: string;
  bundleTitle: string;
  bundleBusy: boolean;
  bundleOutOfSync: number;
  onSyncAllFromServer: () => void;
  syncingAllFromServer: boolean;
}) {
  /**
   * How many mods this install is BEHIND the server on.
   *
   * Only the two states a download can fix. `newer-locally` is not a problem to solve — the
   * server is behind, and "matching" it would roll the local install backwards.
   */
  const serverBehind = (server?.rows ?? []).filter(
    (r) => r.issue === "missing-locally" || r.issue === "outdated-locally"
  ).length;
  // Collapsed panes are remembered per session so a chosen comparison stays put across a
  // rescan. Server starts collapsed when nothing is connected — an empty invitation should
  // not cost a third of the width.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setCollapsed((prev) => ({ ...prev, [k]: !prev[k] }));

  const rowsByKey = new Map((parity?.rows ?? []).map((r) => [r.key, r]));
  const openCount = ["main", "server", "headless"].filter((k) => !collapsed[k]).length;
  const outOfStep = (parity?.counts.missingOnHeadless ?? 0) + (parity?.counts.versionDrift ?? 0);

  /*
   * The shared row model, built ONCE here and handed to both panes.
   *
   * Only when a server is actually connected and reachable — with no server there is nothing to
   * line up against, and forcing the main pane through the aligned renderer would fill it with
   * blanks for rows that do not exist.
   *
   * The search filter is applied HERE, to whole slots, so both panes drop the same rows. Filtering
   * inside each pane would let the two lists disagree about which rows exist, which is the exact
   * drift alignment is meant to remove. A slot survives if EITHER side matches, so searching for a
   * mod you do not have still shows the gap where it would sit.
   */
  const q = searchQuery.trim().toLowerCase();
  const alignedSections =
    serverUrl && server?.reachable
      ? buildAlignedSections(server.rows, mainMods)
          .map((section) => ({
            ...section,
            slots: section.slots.filter(
              (slot) =>
                !q ||
                slot.local?.name.toLowerCase().includes(q) ||
                slot.local?.id.toLowerCase().includes(q) ||
                slot.row?.name.toLowerCase().includes(q) ||
                (slot.row?.serverName ?? "").toLowerCase().includes(q)
            )
          }))
          .filter((section) => section.slots.length > 0)
      : undefined;

  return (
    <div className="hl-wrapper">
      <div className="hl-toolbar">
        <strong>Instances</strong>
        <span className="hl-toolbar-note">
          Main install (local){serverUrl ? ", server (remote, read only)" : ""}
          {headlessPath ? ", headless client (local)" : ""} — filters and search above apply to every pane.
        </span>
        <div className="hl-toolbar-actions">
          {headlessConfigured && (
            <button onClick={onSyncAll} disabled={syncing || outOfStep === 0} className={outOfStep > 0 ? "primary" : ""}>
              {syncing ? "Syncing…" : outOfStep > 0 ? `Sync headless (${outOfStep})` : "Headless in sync"}
            </button>
          )}
          {/* Takes everything the server has that this install lacks or has an older copy of.
              Counts only those two: being NEWER than the server is not a thing to fix, and a
              local extra the server never had is not available to fetch. */}
          {serverUrl && (
            <button
              onClick={onSyncAllFromServer}
              disabled={syncingAllFromServer || serverBehind === 0}
              className={serverBehind > 0 ? "primary" : ""}
              title="Installs or updates every mod the server has that you are missing or behind on. Mods where you are ahead, or that the server does not have, are left alone."
            >
              {syncingAllFromServer ? "Matching…" : serverBehind > 0 ? `Match server (${serverBehind})` : "Matches server"}
            </button>
          )}
          {serverUrl && (
            <button onClick={onSyncBundles} disabled={bundleBusy} className={bundleOutOfSync > 0 ? "primary" : ""} title={bundleTitle}>
              {bundleLabel}
            </button>
          )}
          <button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Rescanning…" : "Rescan all"}
          </button>
          <button onClick={onChangeServer}>{serverUrl ? "Change server" : "Add server"}</button>
          <button onClick={onChangeHeadless}>{headlessPath ? "Change headless" : "Add headless"}</button>
          <button onClick={onExitMultiMode}>Single view</button>
        </div>
      </div>

      {/* Only configured instances get a pane.
       *
       * In practice a setup is one of two shapes, and they do not overlap:
       *   player — their own PC plus a remote server. The host's headless client exists but
       *            is unreachable except in-game, so there is nothing to manage.
       *   host   — their own machine plus a local headless client. They ARE the server, so
       *            there is no remote one to track.
       * Showing the unused pane as a permanent "connect to…" invitation cost a third of the
       * width to something most people will never use. Both can still be added from the
       * toolbar, and all three panes work if someone genuinely wants that. */}
      <div className={`hl-split hl-open-${openCount}`}>
        <InstancePane
          title="Main install"
          subtitle="Local — client + server"
          path={mainPath}
          mods={mainMods}
          rowsByKey={rowsByKey}
          overrides={overrides}
          onOverride={onOverride}
          onToggle={(m) => onToggle(m, "main")}
          onUninstall={(m) => onUninstall(m, "main")}
          onOpenFolder={(m) => onOpenFolder(m, "main")}
          emptyMessage="No mods found in the main install."
          showVerdicts
          collapsed={!!collapsed.main}
          onToggleCollapse={() => toggle("main")}
          filtersActive={filtersActive}
          onSyncMod={onSyncMod}
          syncing={syncing}
          canSync={headlessConfigured}
          alignedSections={alignedSections}
        />

        {serverUrl && (
          <ServerPane
            report={server}
            url={serverUrl}
            collapsed={!!collapsed.server}
            onToggleCollapse={() => toggle("server")}
            onChangeServer={onChangeServer}
            onClearServer={onClearServer}
            onLockToServer={onLockToServer}
            companion={companion}
            onInstallCompanion={onInstallCompanion}
            alignedSections={alignedSections}
            query={searchQuery}
            onInstall={onInstallFromServer}
            installing={installingFromServer}
          />
        )}

        {/* The gutter reconciles the two LOCAL installs, so it belongs to the headless
            client. Without one there is nothing for it to say. */}
        {headlessConfigured && <ParityGutter parity={parity} />}

        {headlessConfigured && (
        <InstancePane
          title="Headless client"
          subtitle="Local — client only, shares the server"
          path={headlessPath}
          mods={headlessMods}
          rowsByKey={rowsByKey}
          overrides={overrides}
          onOverride={onOverride}
          onToggle={(m) => onToggle(m, "headless")}
          // Removing from the headless pane must never touch the main install, so it goes
          // through the headless-scoped removal rather than the shared uninstall.
          onUninstall={onRemoveFromHeadless}
          onOpenFolder={(m) => onOpenFolder(m, "headless")}
          emptyMessage="No plugins installed on the headless client yet."
          showVerdicts={false}
          collapsed={!!collapsed.headless}
          onToggleCollapse={() => toggle("headless")}
          filtersActive={filtersActive}
        />
        )}
      </div>
    </div>
  );
}
