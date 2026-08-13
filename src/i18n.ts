/**
 * This fork is English-only. The type is kept as a one-member union rather than deleted
 * so the translate()/t() call sites and the backend-message layer keep their shape —
 * removing the parameter would touch hundreds of call sites for no behavioural gain.
 */
export type Lang = "en";

type Dict = Record<string, string>;

/**
 * Static UI strings (buttons, labels, headers, tooltips, placeholders).
 * Dot-notation keys grouped by section, to keep them findable.
 * Use {var} inside a string to interpolate via t(key, { var: value }).
 */
const en: Dict = {
  "toast.instanceConfigured": "Instance configured.",
  "toast.folderSelectFailed": "Couldn't select the folder.",
  "toast.dropInvalidFile": "Drop a .zip, .7z, or .rar file to install.",
  "toast.confirmRemove": 'Permanently remove "{name}"?',
  "toast.selectUpdatedFile": "Select the mod's updated file (.zip / .7z / .rar)...",
  "toast.noConflictsFound": "No obvious conflicts found.",
  "toast.conflictsFound": "{count} possible conflict(s) found.",
  "toast.enterSptVersion": "Enter the SPT version before checking.",
  // A warning, not a block: looking at another version's catalogue is legitimate, but
  // installing against it produces mods that load and then misbehave in game.
  "toast.sptVersionOverridden":
    "Showing SPT {chosen}, but this instance is {detected}. Mods installed from here may not run.",
  "toast.forgeUpdateCheckFailed": "Failed to check for updates.",
  "toast.forgeAllUpToDate": "Everything up to date (or not found in the catalogue).",
  "toast.forgeUpdatesAvailable": "{count} update(s) available.",
  "toast.forgeSearchFailed": "Failed to search the mod catalogue.",
  "toast.confirmRemoveBulk": "Permanently remove {count} mod(s)?",
  "toast.bulkProcessed": "{done}/{total} mod(s) processed.",

  "empty.selectFolder": "Select your SPT instance folder to get started.",
  "empty.selectFolderButton": "Select instance folder",
  "empty.downloadModsButton": "Download mods",
  "dropOverlay.text": "Drop the .zip / .7z / .rar file(s) here to install",

  "header.browseForge": "Browse mods",
  "header.browseForgeTitle": "Search and install mods straight from the catalogue",
  // Names the destination, not the outcome: this opens the catalogue in a browser and
  // downloads nothing itself, which "Download mods" implied next to a button that really
  // does install.
  "header.openHub": "Go To Forge",
  "header.openHubTitle": "Open the mod catalogue in the browser",
  "header.changeInstance": "Change instance",
  "header.changeInstanceTitle": "Select a different SPT instance",
  // "Manually" separates it from Browse mods, which installs for you. This one is the
  // fallback for an archive you already have.
  "header.installButton": "Manually Install Mod (.zip / .7z / .rar)",
  "header.installButtonTitle": "Choose a .zip, .7z, or .rar to install",
  "header.installing": "Installing...",
  "header.splitInstance": "Client: {client}  •  Server: {server}",

  "summary.total": "mod(s) installed",
  "summary.active": "Active:",
  "summary.disabled": "Disabled:",
  "summary.versionTooltip":
    "Read from SPT_Data/Server/configs/core.json — starting with SPT 4.0 this file only stores the compatible Tarkov version, not the SPT version itself",
  "summary.validInstance": "Valid instance",
  "summary.validInstanceTitle": "The selected folder passed SPT instance validation",

  "filters.searchPlaceholder": "Search mod by name...",
  "filters.typeFilterTitle": "Filter by type",
  "filters.typeAll": "All types",
  "filters.statusFilterTitle": "Filter by status",
  "filters.statusAll": "Active and disabled",
  "filters.statusEnabled": "Active only",
  "filters.statusDisabled": "Disabled only",
  "filters.originFilterTitle": "Filter by origin",
  "filters.originAll": "Any origin",
  "filters.originManual": "Installed manually",
  "filters.originManager": "Installed by the Manager",
  "filters.sortFieldTitle": "Sort by",
  "filters.sortByName": "Sort by Name",
  "filters.sortByStatus": "Sort by Status",
  "filters.sortByOrigin": "Sort by Origin",
  "filters.sortByInstalledAt": "Sort by Install date",
  "filters.sortByForge": "Sort by Update status",
  "filters.sortDirectionTitle": "Reverse sort direction",
  "filters.sortAsc": "↑ Ascending",
  "filters.sortDesc": "↓ Descending",
  "filters.sortAZ": "↑ A-Z",
  "filters.sortZA": "↓ Z-A",
  "filters.sortOldestFirst": "↑ Oldest first",
  "filters.sortNewestFirst": "↓ Newest first",
  "filters.selectAllVisible": "Select all (visible)",
  "filters.selectAllVisibleTitle": "Select every mod visible with the current filters",
  "filters.clearSelection": "Clear selection",
  "filters.exportList": "Export list",
  "filters.exportListTitle": "Save the current mod list to a JSON file",
  "filters.importCompare": "Import / Compare",
  "filters.importCompareTitle": "Compare the current instance against a previously exported list",
  "filters.checkConflicts": "Check conflicts",
  "filters.checkingConflicts": "Checking...",
  "filters.checkConflictsTitle":
    "Looks for duplicate DLLs between client mods and duplicate names between server mods",
  "filters.checkDeps": "Check dependencies",
  "filters.checkingDeps": "Checking...",
  "filters.checkDepsTitle":
    "Asks the catalogue what your mods need, and lists anything missing or too old for the SPT version you have",
  "filters.sptVersionTitle": "SPT version used when checking for updates — the list comes straight from the catalogue",
  "filters.sptVersionPlaceholder": "select the SPT version...",
  "filters.sptVersionNotListed": "(not listed in the catalogue)",
  "filters.sptVersionLockedTitle":
    "Read from this instance: SPT {version}. Everything — which mods are offered, which build gets installed, what a dependency resolves to — is answered against it.",
  "filters.sptVersionOverriddenTitle":
    "OVERRIDDEN. This instance is SPT {version}. Mods offered here may not run on it.",
  "filters.forgeCheckTitle": "Queries the mod catalogue's public API ({host}) for updates to installed mods",
  "filters.forgeChecking": "Checking for updates...",
  "filters.forgeCheckingProgress": "Checking for updates... ({done}/{total})",
  "filters.forgeCheckButton": "Check for updates",

  "hint.forgeLastChecked": "Last checked: {date}",

  "compare.title": "Comparison with imported list",
  "compare.identical": "Both lists are identical.",
  "compare.missing": "Missing here ({count}):",
  "compare.extra": "Extra here, not in the imported list ({count}):",
  "compare.note":
    "Anything missing here comes with an offer to download it automatically from the catalogue (matched by name) — whatever it can't find that way still needs a manual install, since the app doesn't keep the mods' original files.",

  "conflicts.title": "Conflict check",
  "conflicts.appearsIn": "appears in:",
  "conflicts.nameLabel": "Name",
  "conflicts.sameModTwice": "The same mod is installed in two folders:",
  "conflicts.declaredInMultiple": "declared in more than one folder:",
  "conflicts.note": "File-level check — it flags overlap, it doesn't guarantee an actual incompatibility.",

  "forge.checkTitle": "Update check",
  "forge.updatesAvailable": "Updates available:",
  "forge.updateNow": "Update",
  "forge.updating": "Updating...",
  "forge.updateAll": "Update all ({count})",
  "forge.updateAllTitle": "Downloads and installs every outstanding update, one at a time",
  "forge.updatingAll": "Updating... ({done}/{total})",
  "forge.updateAllDone": "{done} of {total} mod(s) updated.",
  "forge.updatedChip": "Updated",
  "forge.blockedTitle": "Blocked updates (would break a dependency):",
  "forge.incompatibleTitle": "Incompatible with this SPT version:",
  "forge.infoOnlyTitle": "Worth a look, but not offered as an update:",
  "forge.infoHasVersion": "Catalogue has v{version}",
  /* A current release numbered BELOW what is installed. The catalogue's own update check cannot
     report it — it compares numbers and concludes you are ahead — so it is stated plainly with
     both versions, and left as a judgement rather than pushed as an update. */
  "forge.infoRenumbered":
    "you have v{current}, and the catalogue's current build is v{version} — a LOWER number. The author may have renumbered (WTT - Clothing and Gear went 1.0.0-pre2 → 0.1.3), or you may be ahead of the catalogue. Check the mod page before taking it.",
  "forge.allUpToDateDetailed": "Every mod identified in the catalogue is up to date.",
  "forge.unmatchedPrefix": "Not found in the catalogue:",
  "forge.skippedByBudget": "{count} mod(s) weren't checked: the catalogue's request limit was reached. Run the check again to finish — whatever was already resolved is cached and won't be looked up again.",
  "forge.matchNote":
    "Mods are identified by the GUID declared inside their own files, which is exact. Where a mod declares no GUID, the name is used instead and the result is flagged for you to confirm.",

  "forge.dismiss": "Already have it",
  "forge.dismissTitle":
    "Some authors ship a new build without updating the version inside the files. If you know this version is already installed, this stops it being offered — until a newer one appears.",
  "forge.dismissed": "Won't offer {version} for {name} again.",

  "forge.unconfirmedTitle": "Needs confirmation",
  "forge.unconfirmedExplain":
    "These were matched by name rather than by a declared ID, so they might be wrong. Nothing will be updated or downloaded for them until you confirm — a wrong match here would install the wrong mod.",
  "forge.unconfirmedConfirm": "That's correct",
  "forge.unconfirmedRelink": "Wrong — pick another",
  "forge.unconfirmedOpenTitle": "Open this mod's catalogue page to check",
  "forge.relinkTitle": "Which catalogue mod is \"{name}\"?",
  "forge.relinkHelp":
    "Find the mod in the catalogue and paste its page URL here, or enter just the numeric ID. This choice is saved and overrides automatic matching from then on.",
  "forge.relinkSave": "Link it",
  "forge.relinkInvalid": "That didn't look like a mod page URL or ID.",
  // Shows both accepted forms. The slug URL is what the browser gives you today; the bare
  // ID still works, and is what someone reading an older guide will have.
  "forge.relinkPlaceholder": "https://.../mods/sain    or    791",
  "forge.linkSaved": "Linked to {name}. This choice overrides automatic matching from now on.",

  "bulk.selectedCount": "{count} selected",
  "bulk.enable": "Enable",
  "bulk.disable": "Disable",
  "bulk.remove": "Remove",
  "bulk.cancelSelection": "Cancel selection",

  "noResults.text": "No mod matches the current filters/search.",
  "noResults.clearFilters": "Clear filters",

  "common.close": "Close",
  "common.cancel": "Cancel",

  "browse.title": "Search the mod catalogue",
  "browse.searchPlaceholder": "Search by name, slug, or description...",
  "browse.categoryFilterTitle": "Filter by category",
  "browse.sortTitle": "Order the results",
  "browse.sortDownloads": "Most downloaded",
  // "Recently updated" and not "Newest": this orders by each mod's most recent version.
  // The catalogue offers no way to order by when a mod was first added — see BROWSE_SORTS.
  "browse.sortUpdated": "Recently updated",
  "browse.sortName": "Name (A–Z)",
  "browse.allCategories": "All categories",
  "browse.compatibleOnlyTitle": "Uses the SPT version selected in the main filters",
  "browse.compatibleOnlyLabel": "Only compatible with {version}",
  "browse.selectVersionPlaceholder": "(select the SPT version)",
  "browse.searching": "Searching...",
  "browse.searchButton": "Search",
  "browse.noResults": "No mods found with these filters.",
  "browse.viewOnForgeTitle": "View this mod's page (opens in browser)",
  "browse.fikaCompatibleTitle": "Has a Fika-compatible version",
  "browse.byAuthor": "by {author}",
  "browse.downloadsLabel": "downloads",
  "browse.chooseVersionTitle": "Choose the version to install",
  "browse.installing": "Installing...",
  "browse.installButton": "Install",
  "browse.reinstallButton": "Reinstall",
  "browse.upgradeButton": "Upgrade to {version}",
  "browse.downgradeButton": "Downgrade to {version}",
  "browse.installedChip": "Installed",
  "browse.installedChipVersion": "Installed v{version}",
  "browse.installedTitle": "You already have this mod — identified from the saved catalogue match, not guessed by name",
  "browse.actionTitle": "You have v{installed} installed. Installing overwrites it with the version selected here.",
  "browse.noVersionPublished": '"{name}" has no published version to install.',
  "browse.noVersionPublishedShort": "No version published",
  "browse.prevPage": "← Previous",
  "browse.pageOf": "Page {page} of {lastPage}",
  "browse.nextPage": "Next →",
  "browse.installNote":
    'Installing downloads the file straight from the catalogue and runs it through the same installer as the "Install mod" button — including client/server mod detection and registering it with the Manager.',

  "confirm.title": "Unusual file structure",
  "confirm.descriptionPrefix": "I couldn't find any DLL,",
  "confirm.descriptionMid": "or a",
  "confirm.descriptionSuffix":
    "folder in this file. This could be a mod packaged in an unusual way, or the wrong file. Here's what's in the root of the file:",
  "confirm.emptyArchive": "(empty archive)",
  "confirm.explanation":
    'If you recognize this as a valid mod, "Continue anyway" copies everything listed above straight into your SPT instance root (the same way auto-detected mods are installed), and registers it as an item you can remove later. If you don\'t recognize it, aborting is safer.',
  "confirm.abort": "Abort",
  "confirm.proceed": "Continue anyway",

  "modlist.emptyCategory": "No mods in this category.",
  "modlist.checkboxTitle": "Click to select, Shift+Click to select a range",
  "modlist.renameTitle": "{name} (double-click to rename)",
  "modlist.statusActive": "Active",
  "modlist.statusDisabled": "Disabled",
  "modlist.forgeUpdateAvailableTitle": "New version available in the catalogue",
  "modlist.forgeUpdateAvailable": "v{version} available",
  "modlist.forgeBlockedTitle": "Has an update, but installing it would break another mod's dependency",
  "modlist.forgeBlocked": "Update blocked",
  "modlist.forgeIncompatibleTitle":
    "The installed version isn't compatible with the SPT version entered in the last check",
  "modlist.forgeIncompatible": "Incompatible",
  "modlist.forgeInfoTitle":
    "No readable local version to compare (mod without package.json, e.g. .dll-only mods) — this is the latest version in the catalogue",
  "modlist.forgeInfo": "Catalogue: v{version}",
  "modlist.orphanTitle": "Loose files tracked by manifest (no folder of its own) — can only be removed",
  "modlist.orphan": "Orphan",
  "modlist.sptIncompatible": "SPT mismatch",
  "modlist.sptIncompatibleTitle": "The mod itself declares support for SPT {declared}, which doesn't match your selected version. Read from the mod's DLL, no internet needed.",
  "modlist.packagePart": "{count}-part package",
  "modlist.packageTooltip": "This mod comes in parts that work together. Enabling or disabling one switches them all. Other parts: {others}",
  "modlist.packageTooltipInferred": "Detected automatically as parts of the same mod (same folder name on both sides). Enabling or disabling one switches them all. Other parts: {others}",
  "modlist.actionsTitle": "Actions",
  "modlist.openFolder": "Open folder",
  "modlist.rename": "Rename",
  "modlist.reinstall": "Reinstall",

  "queue.waiting": "Waiting...",
  "queue.installing": "Installing...",
  "queue.done": "Done",
  "queue.failed": "Failed",
  "queue.noFilePath": "File path not available.",

  "restore.confirmDownload": "Found {count} missing mod(s) from the imported list. Download them automatically from the catalogue?",
  "restore.allInstalled": "{count} mod(s) installed successfully.",
  "restore.partialInstalled": "{installed} installed; not found or failed: {notFound}",
  "restore.confirmDisable": "{count} installed mod(s) aren't in the imported list. Disable those mods?",
  "restore.disabledCount": "{count} mod(s) disabled.",
  "restore.lookingUp": "Looking the mods up in the catalogue...",
  "restore.lookingUpCount": "Looking up in the catalogue... ({done}/{total})",
  "restore.installingProgress": "Installing mods... ({done}/{total})",
  "restore.andMore": " and {count} more",

  "update.available": "New Mod Manager version available: v{latest} (you're on v{current}).",
  // Was "Download on Forge". This fork is not published on Forge, and the link never went
  // there — it pointed at the repository's own releases all along.
  "update.viewRelease": "View release",
  "update.dismiss": "Not now"
};

export const DICTIONARIES: Record<Lang, Dict> = { en };

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  // Falls back to the raw key when a string is missing. That is deliberate: a missing
  // key shows up as visible gibberish rather than a silently blank label.
  let str = DICTIONARIES[lang][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}
/**
 * Pass-through. The backend used to reply in Portuguese, so this function held ~50
 * hand-written regexes translating each known message to English at display time. That
 * layer was fragile in a specific way: any message without a matching rule leaked to the
 * UI untranslated, and adding a backend message meant remembering to add a rule.
 *
 * The backend now emits English directly, so every one of those rules was dead code and
 * has been deleted. The function itself is kept — every call site passes backend messages
 * through it, and it is the natural place to reinstate handling if backend text ever needs
 * transforming again.
 *
 * `lang` is unused for the same reason `Lang` is a one-member union: this fork is
 * English-only. See the note at the top of this file.
 */
export function translateBackendMessage(msg: string | undefined | null, _lang: Lang): string {
  return msg ?? "";
}
