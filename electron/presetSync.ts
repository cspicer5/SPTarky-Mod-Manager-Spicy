/**
 * Making an install match a preset.
 *
 * The comparison view could say what was wrong and offer nothing to fix it: someone handed a
 * preset saw "12 mods missing" and a list. Everything needed to close that gap already
 * existed — payload copying, the Forge installer, the GitHub release installer, the toggle —
 * but nothing joined them up.
 *
 * The interesting part is not the downloading, it is deciding WHERE each mod should come
 * from, and being honest when the answer is "nowhere". That decision is pure and lives here;
 * the actual installing stays in main.ts, where the downloaders are.
 *
 * ## Source order, strongest first
 *
 *   payload  the preset carries the exact bytes. No network, no catalogue, no ambiguity, and
 *            it keeps working after Forge is gone. Always preferred when available.
 *   github   a release on the mod's own repository. Survives the shutdown, and every mod on
 *            the reference install resolves to a repo.
 *   forge    the catalogue, while it exists. Last because it dies on 2026-08-10.
 *
 * A mod with none of these is reported, never guessed at. Installing "something with a
 * similar name" into a game install is not a small mistake.
 */
import { ModType } from "./types";
import { Preset, PresetMod, PresetReport, PresetAddon } from "./presets";

export type SyncSource = "payload" | "github" | "forge" | "none";

export interface SyncStep {
  name: string;
  type: ModType;
  /** Why this step exists — what the comparison found. */
  reason: "missing" | "version-mismatch" | "state-mismatch" | "addon-missing";
  source: SyncSource;
  wantVersion?: string;
  haveVersion?: string;
  /** For a state-mismatch, what it should end up as. */
  wantEnabled?: boolean;
  payloadKey?: string;
  sourceUrl?: string;
  /**
   * The mod's own GUID, carried from the preset.
   *
   * Load-bearing, not decoration. Without it the catalogue lookup falls back to searching by
   * FOLDER name, which is not the published name: "BorkelRNVG", "WTT-Artem" and
   * "tacticaltoaster-untargohome" all resolve to nothing, and "fika-server" resolves to the
   * WRONG MOD — Fika Headless Launcher rather than Project Fika - Server. All five are exact
   * with the GUID.
   */
  guid?: string;
  forgeAddonId?: number;
  parentName?: string;
  /** Set when nothing can supply this, so the UI can say why rather than just fail. */
  blockedReason?: string;
}

export interface SyncPlan {
  steps: SyncStep[];
  /** Steps that can actually be carried out. */
  actionable: SyncStep[];
  /** Steps with no available source, kept so the user is told rather than left guessing. */
  blocked: SyncStep[];
  counts: {
    install: number;
    update: number;
    toggle: number;
    addons: number;
    blocked: number;
  };
  /** Bytes to copy from payloads, when the preset carries them. */
  payloadBytes: number;
}

export interface SyncOptions {
  /** Payloads are only usable when a store holding them is connected. */
  storeConnected: boolean;
  /** False after 2026-08-10, or when the user is offline. */
  forgeAvailable: boolean;
  /** Leave mods alone that the preset does not mention. Never destructive by default. */
  removeExtras?: boolean;
}

function sourceFor(mod: PresetMod | undefined, opts: SyncOptions): { source: SyncSource; blockedReason?: string } {
  if (!mod) return { source: "none", blockedReason: "Not described by this preset." };
  // Exact bytes, no network, and unaffected by the shutdown.
  if (mod.payload && opts.storeConnected) return { source: "payload" };
  if (mod.sourceUrl && /github\.com/i.test(mod.sourceUrl)) return { source: "github" };
  if (opts.forgeAvailable) return { source: "forge" };

  return {
    source: "none",
    blockedReason: mod.payload
      ? "This preset carries the files, but its store is not connected."
      : mod.sourceUrl
        ? `No automatic source. Get it from ${mod.sourceUrl}`
        : "No payload, no source link, and Forge is unavailable."
  };
}

/**
 * Works out what would have to happen for this install to match the preset.
 *
 * Deliberately additive: a mod installed here but absent from the preset is left alone unless
 * `removeExtras` is asked for. A preset says what a setup needs, not what it forbids, and
 * deleting somebody's mods because they are missing from a list is a far more destructive
 * reading than anyone asked for.
 */
export function buildSyncPlan(preset: Preset, report: PresetReport, opts: SyncOptions): SyncPlan {
  const byKey = new Map<string, PresetMod>();
  for (const m of preset.mods) byKey.set(`${m.type}:${m.name.toLowerCase()}`, m);

  const steps: SyncStep[] = [];
  let payloadBytes = 0;

  for (const row of report.rows) {
    // "extra" is somebody else's mod, and "orphaned-addon" is a flaw in the preset itself
    // rather than something this install can fix by downloading.
    if (!row.issue || row.issue === "extra" || row.issue === "unknown-version" || row.issue === "orphaned-addon") {
      continue;
    }

    const want = byKey.get(`${row.type}:${row.name.toLowerCase()}`);

    if (row.issue === "state-mismatch") {
      // Needs no source at all — it is already installed, just switched the wrong way.
      steps.push({
        name: row.name,
        type: row.type,
        reason: "state-mismatch",
        source: "none",
        wantEnabled: row.presetEnabled,
        wantVersion: row.presetVersion
      });
      continue;
    }

    const { source, blockedReason } = sourceFor(want, opts);
    if (source === "payload") payloadBytes += want?.sizeBytes ?? 0;

    steps.push({
      name: row.name,
      type: row.type,
      reason: row.issue === "missing" ? "missing" : "version-mismatch",
      source,
      wantVersion: row.presetVersion,
      haveVersion: row.localVersion,
      wantEnabled: row.presetEnabled,
      payloadKey: want?.payload,
      sourceUrl: want?.sourceUrl,
      // Carried so the install can match exactly instead of guessing from a folder name.
      guid: want?.guid,
      blockedReason
    });
  }

  /*
   * Addons last, because installing one before its parent exists would either fail or patch
   * the wrong thing. An addon that lives inside its parent's folder needs no step of its own
   * when that parent is being installed from a payload — the files come with it — but it DOES
   * when the parent is already present and only the patch is missing.
   */
  const parentsBeingInstalled = new Set(
    steps.filter((s) => s.reason === "missing" && s.source === "payload").map((s) => `${s.type}:${s.name.toLowerCase()}`)
  );

  for (const addon of report.addonRows ?? []) {
    if (addon.status !== "missing") continue; // present, or its parent is not here at all
    const carriedByParent =
      addon.mergedIntoParent && parentsBeingInstalled.has(`${addon.parentType}:${addon.parentName.toLowerCase()}`);
    if (carriedByParent) continue;

    const canInstall = addon.forgeAddonId !== undefined && opts.forgeAvailable;
    steps.push({
      name: addon.name,
      type: addon.parentType,
      reason: "addon-missing",
      source: canInstall ? "forge" : "none",
      wantVersion: addon.version,
      forgeAddonId: addon.forgeAddonId,
      parentName: addon.parentName,
      blockedReason: canInstall
        ? undefined
        : addon.mergedIntoParent
          ? `Its files live inside "${addon.parentName}". Connect the preset's store and sync with mod files, or reinstall the patch by hand.`
          : "No source available for this addon."
    });
  }

  const blocked = steps.filter((s) => s.source === "none" && s.reason !== "state-mismatch");
  const actionable = steps.filter((s) => !blocked.includes(s));

  return {
    steps,
    actionable,
    blocked,
    payloadBytes,
    counts: {
      install: steps.filter((s) => s.reason === "missing" && s.source !== "none").length,
      update: steps.filter((s) => s.reason === "version-mismatch" && s.source !== "none").length,
      toggle: steps.filter((s) => s.reason === "state-mismatch").length,
      addons: steps.filter((s) => s.reason === "addon-missing" && s.source !== "none").length,
      blocked: blocked.length
    }
  };
}

/** A one-line summary of what a sync would do, for the confirmation the user sees first. */
export function describeSyncPlan(plan: SyncPlan): string {
  const parts: string[] = [];
  if (plan.counts.install) parts.push(`install ${plan.counts.install} mod(s)`);
  if (plan.counts.update) parts.push(`update ${plan.counts.update}`);
  if (plan.counts.addons) parts.push(`install ${plan.counts.addons} addon(s)`);
  if (plan.counts.toggle) parts.push(`switch ${plan.counts.toggle} on or off`);
  if (parts.length === 0) return "Nothing to do — this install already matches.";
  const summary = parts.join(", ");
  return plan.counts.blocked > 0
    ? `${summary}. ${plan.counts.blocked} cannot be sourced automatically.`
    : `${summary}.`;
}
