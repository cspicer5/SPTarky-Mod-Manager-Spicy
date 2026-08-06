/**
 * Fika headless client support.
 *
 * A headless client is a second, full SPT+Fika client instance that automatically hosts
 * raids so the AI is computed somewhere other than the machine you play on. The one fact
 * that shapes this entire module is quoted from Fika's wiki:
 *
 *   "The headless client is a *client* — clients only load things in BepInEx/. Any mod
 *    that is in SPT/user/mods/ is loaded only by the backend server, SPT.Server.exe."
 *
 * Three consequences follow, and they are why this is not simply "scan a second folder":
 *
 *   1. A headless instance has NO server side. Server mods are not "incompatible" with it,
 *      they are never loaded by it. That is structural, so it is decided here in code and
 *      is never a guess.
 *   2. There is exactly one server in a Fika setup, shared by everyone. So the headless
 *      client must agree with the MAIN install on every plugin that alters raid behaviour,
 *      because the headless client is the raid host and is authoritative.
 *   3. Not every client plugin belongs on it. Fika's guidance is a decision procedure, not
 *      a list, and it is deliberately hedged — see data/headless-rules.json.
 *
 * On evidence, this module follows the same rule the Forge matcher settled on in V1: a
 * guess is labelled a guess. `source` on every verdict says what the classification rests
 * on, and the UI is expected to show it.
 */
import fs from "fs";
import path from "path";
import { ModInfo, ModType } from "./types";

/* --------------------------------------------------------------------------
 * Detection
 * ----------------------------------------------------------------------- */

// Written by Fika-Installer into the headless install and nowhere else. This is the only
// unambiguous marker: a headless install is otherwise a byte-for-byte ordinary SPT client,
// so looking for EscapeFromTarkov.exe or BepInEx/ cannot tell the two apart.
const HEADLESS_MANAGER_EXE = "FikaHeadlessManager.exe";

// Fallback markers, used only to explain a near miss to the user rather than to accept one.
const CLIENT_EXE = "EscapeFromTarkov.exe";

export interface HeadlessInstancePaths {
  root: string;
  /** True when FikaHeadlessManager.exe was found — a positive identification. */
  confirmed: boolean;
}

export interface HeadlessResolution {
  instance: HeadlessInstancePaths;
  /** True when the instance was found in a subfolder rather than the folder picked. */
  autoDetected: boolean;
}

function looksLikeHeadless(dir: string): boolean {
  return fs.existsSync(path.join(dir, HEADLESS_MANAGER_EXE));
}

function looksLikeClient(dir: string): boolean {
  return fs.existsSync(path.join(dir, CLIENT_EXE)) || fs.existsSync(path.join(dir, "BepInEx"));
}

/**
 * Resolves a headless install from the folder the user picked, looking one level down as
 * well — the Fika installer is run from inside a folder the user creates, so people
 * routinely pick the parent.
 *
 * Deliberately strict: an ordinary SPT client is accepted ONLY if it carries the headless
 * manager. Accepting any client folder would let someone point the headless side at their
 * main install, and the app would then happily report perfect parity between a folder and
 * itself while nothing was actually hosting.
 */
export function resolveHeadlessInstance(chosenPath: string): HeadlessResolution | null {
  if (!fs.existsSync(chosenPath) || !fs.statSync(chosenPath).isDirectory()) return null;

  if (looksLikeHeadless(chosenPath)) {
    return { instance: { root: chosenPath, confirmed: true }, autoDetected: false };
  }

  let subEntries: fs.Dirent[] = [];
  try {
    subEntries = fs.readdirSync(chosenPath, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }

  for (const entry of subEntries) {
    const candidate = path.join(chosenPath, entry.name);
    if (looksLikeHeadless(candidate)) {
      return { instance: { root: candidate, confirmed: true }, autoDetected: true };
    }
  }

  return null;
}

/** Explains a rejection in the user's terms rather than returning a bare failure. */
export function describeHeadlessRejection(chosenPath: string): string {
  if (!fs.existsSync(chosenPath)) return "That folder does not exist.";
  if (looksLikeClient(chosenPath)) {
    return (
      `That looks like an ordinary SPT client, not a headless one — no ${HEADLESS_MANAGER_EXE} in it. ` +
      "Create the headless install with Fika-Installer first (Advanced → Create Headless), then pick that folder."
    );
  }
  return `No headless client found there. Pick the folder containing ${HEADLESS_MANAGER_EXE}.`;
}

/* --------------------------------------------------------------------------
 * The compatibility ruleset
 * ----------------------------------------------------------------------- */

export type HeadlessClass = "required" | "recommended" | "optional" | "unnecessary" | "unknown" | "server-only";

/**
 * What the verdict rests on. Ordered strongest to weakest, and shown in the UI, because
 * "Fika's wiki names this mod" and "its Forge category is Audio" are not the same claim.
 */
export type HeadlessVerdictSource = "manual" | "structural" | "rule" | "pairing" | "category" | "none";

export interface HeadlessVerdict {
  klass: HeadlessClass;
  source: HeadlessVerdictSource;
  why: string;
  /** Patches menus — a specific hazard, since the headless client drives menus itself. */
  menuRisk?: boolean;
  /** How to carry this mod's configuration across, when it needs special handling. */
  config?: string;
}

interface RuleMatch {
  folder?: string[];
  guid?: string[];
}

interface HeadlessRule {
  id: string;
  match: RuleMatch;
  class: HeadlessClass;
  why: string;
  menuRisk?: boolean;
  config?: string;
}

interface HeadlessRulesFile {
  version: number;
  rules: HeadlessRule[];
  categoryHints: Record<string, string>;
}

let rulesCache: HeadlessRulesFile | null = null;

function loadRules(): HeadlessRulesFile {
  if (rulesCache) return rulesCache;
  // __dirname is dist-electron/ in development and inside app.asar once packaged; data/ sits
  // beside it in both cases (see the "files" list in package.json). Resolved lazily and
  // defensively — a missing ruleset must degrade to "unknown", never crash the scan.
  const candidates = [
    path.join(__dirname, "..", "data", "headless-rules.json"),
    path.join(process.cwd(), "data", "headless-rules.json")
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as HeadlessRulesFile;
      if (Array.isArray(parsed?.rules)) {
        rulesCache = parsed;
        return rulesCache;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  rulesCache = { version: 0, rules: [], categoryHints: {} };
  return rulesCache;
}

/**
 * Folder and file names are the practical join key: "DrakiaXYZ-BigBrain.dll" and
 * "DrakiaXYZ-BigBrain/" are the same mod shipped two ways, and neither exposes a GUID
 * without opening the assembly.
 */
export function normaliseModKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.dll$/, "")
    .replace(/^\d+[-_.\s]+/, ""); // strip a load-order prefix, e.g. "01-SomeMod"
}

/**
 * Row identity for the parity table, scoped by side.
 *
 * "server" vs everything else is the only distinction that matters: a headless instance has
 * no server, so a client plugin can only ever pair with a client plugin. Without the scope,
 * a mod shipping both halves under one folder name collapses into a single row and one half
 * silently adopts the other's verdict.
 */
export function parityKey(mod: Pick<ModInfo, "id" | "type">): string {
  return `${mod.type === "server" ? "server" : "client"}:${normaliseModKey(mod.id)}`;
}

/**
 * Reduces a mod name to the identity it shares with its counterpart on the other side.
 *
 * Content mods ship in halves that are named for the side they sit on, and there is no
 * single convention: "BlackDiv" pairs with "BlackDivServer", "WTT-ArmoryClient" with
 * "WTT-Armory", "ISBAishiPlugin" with "ISB-Aishi", "WTT-ClientCommonLib" with
 * "WTT-ServerCommonLib". Dropping the separators and the side/role words collapses all
 * four shapes onto one key.
 */
function pairingCore(name: string): string {
  return normaliseModKey(name)
    .replace(/[^a-z0-9]/g, "")
    .replace(/(client|server|plugin)/g, "")
    .replace(/mod$/, "");
}

/**
 * Every server mod in the MAIN install, keyed for pairing. Built once per scan and passed
 * in, so classification stays a pure function of its inputs.
 */
export function buildServerCounterpartIndex(mainMods: ModInfo[]): Set<string> {
  const index = new Set<string>();
  for (const mod of mainMods) {
    if (mod.type !== "server") continue;
    const core = pairingCore(mod.id);
    if (core.length >= 3) index.add(core);
  }
  return index;
}

function ruleFor(mod: Pick<ModInfo, "id" | "originalName" | "guid">): HeadlessRule | undefined {
  const { rules } = loadRules();
  const keys = new Set([normaliseModKey(mod.id), normaliseModKey(mod.originalName)]);
  const guid = mod.guid?.trim().toLowerCase();

  for (const rule of rules) {
    if (guid && rule.match.guid?.some((g) => g.toLowerCase() === guid)) return rule;
    if (rule.match.folder?.some((f) => keys.has(normaliseModKey(f)))) return rule;
  }
  return undefined;
}

export interface ForgeHint {
  category?: string;
  /**
   * Forge's author-declared Fika flag. TRUE is meaningful; FALSE is not.
   *
   * Verified against the live API before the shutdown: BigBrain and Waypoints both report
   * false, and both are SAIN dependencies that plainly work under Fika — their author
   * simply never ticked the box. So `false` means "not declared", not "known broken", and
   * this module never draws a negative conclusion from it.
   */
  fikaCompatible?: boolean;
}

/**
 * Decides whether a mod belongs on the headless client.
 *
 * Precedence: what is structurally true > what the user said > what Fika documents > what
 * the mod's category hints at > nothing. Anything below "rule" is explicitly a suggestion
 * to review, and says so in `why`.
 */
export function classifyForHeadless(
  mod: Pick<ModInfo, "id" | "originalName" | "guid" | "type">,
  opts: { manual?: HeadlessClass; forge?: ForgeHint; serverCounterparts?: Set<string> } = {}
): HeadlessVerdict {
  // Checked BEFORE the manual override, which is the one place user intent does not win:
  // this is a fact about how SPT loads mods, not a preference. Nothing under user/mods is
  // ever read by a client, so no setting can make a server mod load on a headless one.
  //
  // It also has to be first for a subtler reason. Overrides are keyed by mod name without a
  // side, because "SAIN is required" is a statement about SAIN — but several mods ship a
  // server half and a client half under ONE folder name. With the override checked first,
  // marking such a client plugin "required" silently re-labelled its server twin as
  // required-and-missing too, inventing a problem that cannot exist. The user is never
  // offered that control for a server row; it leaked across from the client half.
  if (mod.type === "server") {
    return {
      klass: "server-only",
      source: "structural",
      why: "Server mod. A headless client only loads BepInEx/ — nothing in user/mods/ is ever read by it, so this belongs solely to the main install."
    };
  }

  if (opts.manual) {
    return { klass: opts.manual, source: "manual", why: "Set by you." };
  }

  const rule = ruleFor(mod);
  if (rule) {
    return {
      klass: rule.class,
      source: "rule",
      why: rule.why,
      menuRisk: rule.menuRisk,
      config: rule.config
    };
  }

  // The client half of a mod whose server half is installed. The shared server WILL load
  // that server half, and Fika's wiki names this as a cause of headless clients failing to
  // start: "sometimes also from missing a plugin that is required by one of the mods on the
  // server". So the pairing is evidence, not a hunch — but it is weaker than a documented
  // rule, hence its own source, and it never outranks one.
  if (opts.serverCounterparts?.has(pairingCore(mod.id))) {
    return {
      klass: "recommended",
      source: "pairing",
      why:
        "Client half of a mod whose server half is installed. The shared server loads that half regardless, and Fika's wiki attributes headless start-up failures to missing plugins required by a server mod."
    };
  }

  const hint = opts.forge?.category ? loadRules().categoryHints?.[opts.forge.category] : undefined;
  if (hint) {
    return {
      klass: hint as HeadlessClass,
      source: "category",
      why: `Not covered by Fika's guidance. Suggested from its Forge category (${opts.forge!.category}) — worth confirming, since a category describes subject matter rather than raid-time behaviour.`
    };
  }

  return {
    klass: "unknown",
    source: "none",
    why: "No guidance for this one. Fika's advice for ambiguous plugins is to leave it installed, run a raid, and check the logs rather than guess."
  };
}

/**
 * Forge category / Fika flag for every mod in the pre-shutdown harvest, keyed for lookup by
 * folder name and by GUID.
 *
 * Read lazily from disk rather than imported, because the file is ~1.4 MB: bundling it into
 * the main process would pay that cost at every launch for a signal only used to break ties
 * on the handful of plugins no rule covers. Missing file degrades to "no hints".
 */
let forgeHintCache: Record<string, ForgeHint> | null = null;

export function loadForgeHints(): Record<string, ForgeHint> {
  if (forgeHintCache) return forgeHintCache;
  const candidates = [
    path.join(__dirname, "..", "data", "forge-directory.json"),
    path.join(process.cwd(), "data", "forge-directory.json")
  ];
  const hints: Record<string, ForgeHint> = {};
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
        mods?: { name?: string; guid?: string; category?: string; fikaCompatible?: boolean }[];
      };
      for (const mod of parsed.mods ?? []) {
        const hint: ForgeHint = { category: mod.category, fikaCompatible: mod.fikaCompatible };
        if (mod.name) hints[normaliseModKey(mod.name)] = hint;
        if (mod.guid) hints[normaliseModKey(mod.guid)] = hint;
      }
      break;
    } catch {
      // fall through
    }
  }
  forgeHintCache = hints;
  return hints;
}

/** Hints for a specific set of installed mods, keyed the way the parity report expects. */
export function forgeHintsFor(mods: ModInfo[]): Record<string, ForgeHint> {
  const all = loadForgeHints();
  const out: Record<string, ForgeHint> = {};
  for (const mod of mods) {
    const hint = all[normaliseModKey(mod.id)] ?? all[normaliseModKey(mod.originalName)] ?? (mod.guid ? all[normaliseModKey(mod.guid)] : undefined);
    if (hint) out[normaliseModKey(mod.id)] = hint;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Parity between the two instances
 * ----------------------------------------------------------------------- */

export type ParityIssue =
  | "version-drift"
  | "missing-required"
  | "missing-recommended"
  | "headless-only"
  | "server-mod-in-headless"
  | "unnecessary-menu-risk";

export interface ParityRow {
  /**
   * Collision-safe row identity, scoped by side. Mods routinely ship a server half and a
   * client half under the SAME folder name — "acidphantasm-botplacementsystem" and
   * "com.swiftxp.spt.showmethemoney" both do. Keying rows by name alone let the server row
   * overwrite the client row, so the client plugin rendered with the server's "server only"
   * verdict and looked like it would never load.
   */
  key: string;
  /** Plain normalised mod name, for manual overrides — those apply to a mod, not a side. */
  modKey: string;
  name: string;
  type: ModType;
  mainVersion?: string;
  headlessVersion?: string;
  presence: "both" | "main-only" | "headless-only";
  verdict: HeadlessVerdict;
  issue?: ParityIssue;
  detail?: string;
}

export interface ParityReport {
  rows: ParityRow[];
  counts: {
    /** Plugins that must match and do. */
    aligned: number;
    versionDrift: number;
    missingOnHeadless: number;
    headlessOnly: number;
    needsReview: number;
  };
}

/**
 * Compares the two instances plugin by plugin.
 *
 * Only client-side mods can ever be compared: the headless client has no server, so a
 * server mod present only in the main install is correct rather than missing. Getting that
 * backwards would report ~26 phantom problems on a normal install.
 */
export function buildParityReport(
  mainMods: ModInfo[],
  headlessMods: ModInfo[],
  opts: { manual?: Record<string, HeadlessClass>; forge?: Record<string, ForgeHint> } = {}
): ParityReport {
  const manual = opts.manual ?? {};
  const forge = opts.forge ?? {};
  const rows: ParityRow[] = [];

  const keyOf = (mod: ModInfo) => parityKey(mod);
  const headlessByKey = new Map(headlessMods.map((m) => [keyOf(m), m]));
  const mainByKey = new Map(mainMods.map((m) => [keyOf(m), m]));

  // Built from the MAIN install only: it stands for what the shared server will load, and
  // the headless install has no server of its own to contribute.
  const serverCounterparts = buildServerCounterpartIndex(mainMods);

  const verdictFor = (mod: ModInfo) =>
    classifyForHeadless(mod, {
      manual: manual[normaliseModKey(mod.id)],
      forge: forge[normaliseModKey(mod.id)],
      serverCounterparts
    });

  for (const mod of mainMods) {
    const key = keyOf(mod);
    const twin = headlessByKey.get(key);
    const verdict = verdictFor(mod);

    // A server mod is never "missing" from the headless client — it cannot exist there. But
    // it can be sitting there uselessly, and that IS worth reporting: people create the
    // headless install by copying their main one, which brings user/mods along. The copy
    // looks correct, is never loaded, and nothing anywhere raises an error.
    //
    // This must be checked here rather than in the headless-only pass below, because the
    // usual case is a server mod present in BOTH folders, which that pass skips by design.
    if (verdict.klass === "server-only") {
      const strayTwin = headlessByKey.get(key);
      rows.push({
        key,
        modKey: normaliseModKey(mod.id),
        name: mod.name,
        type: mod.type,
        mainVersion: mod.version,
        headlessVersion: strayTwin?.version,
        presence: strayTwin ? "both" : "main-only",
        verdict,
        issue: strayTwin ? "server-mod-in-headless" : undefined,
        detail: strayTwin
          ? "Also present in the headless install's user/mods, where nothing will ever load it. Harmless, but it is not doing what it looks like it is doing."
          : undefined
      });
      continue;
    }

    if (twin) {
      const drift = !!mod.version && !!twin.version && mod.version !== twin.version;
      rows.push({
        key,
        modKey: normaliseModKey(mod.id),
        name: mod.name,
        type: mod.type,
        mainVersion: mod.version,
        headlessVersion: twin.version,
        presence: "both",
        verdict,
        issue: drift ? "version-drift" : undefined,
        detail: drift
          ? `Main has ${mod.version}, headless has ${twin.version}. The raid host is authoritative, so a mismatch on a behaviour mod changes the raid for everyone.`
          : undefined
      });
      continue;
    }

    let issue: ParityIssue | undefined;
    if (verdict.klass === "required") issue = "missing-required";
    else if (verdict.klass === "recommended") issue = "missing-recommended";

    rows.push({
      key,
      modKey: normaliseModKey(mod.id),
      name: mod.name,
      type: mod.type,
      mainVersion: mod.version,
      presence: "main-only",
      verdict,
      issue,
      detail: issue ? "Installed on the main instance but not on the headless client." : undefined
    });
  }

  for (const mod of headlessMods) {
    const key = keyOf(mod);
    if (mainByKey.has(key)) continue;

    // A server mod sitting in the headless folder is inert: the headless client has no
    // server to load it. Worth saying out loud, because the folder looks identical to a
    // working install and nothing reports an error.
    if (mod.type === "server") {
      rows.push({
        key,
        modKey: normaliseModKey(mod.id),
        name: mod.name,
        type: mod.type,
        headlessVersion: mod.version,
        presence: "headless-only",
        verdict: classifyForHeadless(mod),
        issue: "server-mod-in-headless",
        detail: "Sitting in the headless install's user/mods, where nothing will ever load it."
      });
      continue;
    }

    rows.push({
      key,
      modKey: normaliseModKey(mod.id),
      name: mod.name,
      type: mod.type,
      headlessVersion: mod.version,
      presence: "headless-only",
      verdict: verdictFor(mod),
      issue: "headless-only",
      detail: "On the headless client but not on the main install. Usually the leftovers of an older setup."
    });
  }

  // Menu-patching plugins are flagged even when both sides agree: the headless client
  // navigates menus on its own to enter and leave a raid, so a menu patch is the one class
  // of "harmless" mod that can stop it hosting entirely.
  for (const row of rows) {
    if (!row.issue && row.presence !== "main-only" && row.verdict.menuRisk) {
      row.issue = "unnecessary-menu-risk";
      row.detail =
        "Patches menus. The headless client drives its own menus to start and finish raids, so this is worth removing if it ever fails to host.";
    }
  }

  const counts = {
    // Counts only the mods that are SUPPOSED to match. A cosmetic plugin sitting on both
    // sides is not an alignment achievement, and folding it in here would inflate the one
    // number a user reads as "am I set up correctly?".
    aligned: rows.filter(
      (r) => r.presence === "both" && !r.issue && (r.verdict.klass === "required" || r.verdict.klass === "recommended")
    ).length,
    versionDrift: rows.filter((r) => r.issue === "version-drift").length,
    missingOnHeadless: rows.filter((r) => r.issue === "missing-required" || r.issue === "missing-recommended").length,
    headlessOnly: rows.filter((r) => r.issue === "headless-only" || r.issue === "server-mod-in-headless").length,
    // Every undecided mod counts, including ones only on the main install — "should this be
    // copied across?" is precisely the question awaiting an answer. Excluding main-only rows
    // reported 0 on an install that had two genuinely undecided plugins.
    needsReview: rows.filter((r) => r.verdict.klass === "unknown").length
  };

  const severity: Record<string, number> = {
    "missing-required": 0,
    "version-drift": 1,
    "missing-recommended": 2,
    "server-mod-in-headless": 3,
    "unnecessary-menu-risk": 4,
    "headless-only": 5
  };
  rows.sort((a, b) => {
    const sa = a.issue ? severity[a.issue] ?? 9 : 9;
    const sb = b.issue ? severity[b.issue] ?? 9 : 9;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });

  return { rows, counts };
}
