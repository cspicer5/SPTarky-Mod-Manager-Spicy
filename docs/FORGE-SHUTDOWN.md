# SPT Forge shutdown — 2026-08-10

SPT Forge is scheduled to shut down on **10 August 2026**. Every Forge-backed feature in
this app stops working on that date. This note records what breaks, what still works, and
what the options are afterwards.

It is a planning document, not a work item. The current milestone is deliberately still
"make the Forge integration correct" — see the reasoning under *Why finish the Forge work
anyway*.

## Time-critical: capture the data before it is gone

Once Forge is offline, the mapping from an installed mod to its Forge identity is
**unrecoverable**. The API is the only place that mapping exists.

The match cache (`.spt-mod-manager-forge-match.json`) is therefore not just a speed
optimisation any more — after the shutdown it is an archive. Anything resolved and written
before 12 August keeps working offline; anything not resolved is lost.

Concretely, before the shutdown it is worth running, against each real install:

```
npm run audit:forge -- "<path to install>" --write
```

The `--write` flag is what persists the resolved IDs. Note that only confirmed matches are
written by design, so anything still flagged `[NEEDS CONFIRMATION]` should be resolved via
the manual pin (Tier 4) **before** the deadline, or it will not be captured.

A fuller snapshot (mod name, ID, GUID, author, latest version and download URL per
installed mod) would be more useful still, and is cheap to take while the API is up.

## What breaks on 12 August

| Feature | Impact |
|---|---|
| Update checking (`/mods/updates`) | gone — no way to learn a newer version exists |
| Mod browsing / catalogue search | gone |
| One-click install from Forge | gone — download URLs point at Forge hosting |
| Modlist restore (auto-download missing mods) | gone |
| SPT version picker (`/spt/versions`) | gone — falls back to free-text entry |
| Forge identity matching | gone — but cached IDs remain usable |

## What keeps working

Everything local, which after the recent work is a larger share than it used to be:

- Install / uninstall / enable / disable, including package cascades
- Conflict detection (duplicate DLLs, duplicate GUIDs)
- **SPT compatibility checking** — read from each mod's own DLL, never from the API
- Mod metadata (GUID, name, version, author) via the CLI metadata reader
- The match cache, as a historical record

## V2 options after the shutdown

Not decided. Recorded so the reasoning is not lost.

**1. GitHub-based, seeded from a harvested directory.** *(current preferred direction)*

Build a directory mapping every Forge mod to its GitHub repository, harvested from Forge
**before** the shutdown, then use GitHub's releases API for update checking afterwards,
with the ability to add new mods to the directory by hand.

Crucially this does **not** require scraping. The API exposes the links directly:

```
GET /api/v0/mods?include=source_code_links
```

### Measured coverage

A first estimate put this at 92%, but that sampled only the top-by-downloads and
most-recently-created mods — the actively maintained ones — and does not hold for the
catalogue as a whole. The full harvest (all 2,389 mods, 2026-08-05) gives the real picture,
and coverage tracks popularity closely:

| Slice of the catalogue | Has a source link |
|---|---|
| Mods actually installed on a real 54-mod setup | **36 / 36 (100%)** |
| Top 200 by downloads | 165 / 200 (83%) |
| Top 500 | 379 / 500 (76%) |
| Top 1000 | 687 / 1000 (69%) |
| **All 2,389** | **1,450 (61%)** |

Of the 1,450 with a link, **1,350 (93%) are GitHub**; the rest are gitlab.com,
dev.sp-tarkov.com and codeberg.org.

The headline number is therefore 61%, not 92% — but the 61% is dominated by old, abandoned
mods nobody installs. For mods people actually run, coverage is close to total: every mod
on the reference install had a GitHub URL. Examples:
`BigBrain -> github.com/DrakiaXYZ/SPT-BigBrain`, `SAIN -> github.com/ArchangelWTF/SAIN`.

Mods with no published link need another route — manual entry, or matching by name against
GitHub search. Note also that only 744 of 2,389 (31%) publish a GUID, so the GUID-first
matching that works so well on modern SPT 4.0 mods will not carry older ones; for those the
harvested id/name/slug is the only handle.

Rate limits differ from Forge and matter here: GitHub allows 60 requests/hour per IP
unauthenticated, versus 5,000/hour with a token. Unlike Forge, GitHub auth is real and
raises limits substantially, so a personal access token becomes worthwhile. Checking ~50
installed mods is impossible unauthenticated but trivial with a token.

**This harvest has a hard deadline.** After 12 August the mapping cannot be rebuilt. It
should be captured as a versioned JSON file committed to this repo, covering every mod on
Forge rather than only the ones currently installed — that way the directory is useful for
mods installed later, and can be shared.

**2. A Forge successor.** If the community stands up a replacement, the work done here
ports readily: the matching architecture (identity resolution, provenance, confidence,
manual override) is not Forge-specific. Only the transport and the field names would change.
Worth keeping the Forge client isolated behind a narrow interface to make that swap cheap.

**3. Local-only.** Drop remote update checking; keep install management and the local
compatibility check. The least work and the least capability.

**4. Community modlist sharing.** Export/import already exists. Without a registry to
resolve names, restore would need to carry download URLs or file hashes in the list itself.

## Why finish the Forge work anyway

Three reasons, given the deadline is close:

1. **The cache is the archive.** Better matching before the shutdown means more mods
   captured permanently. Work done now is the difference between an install that remembers
   its Forge identities and one that does not.
2. **Most of it is not Forge-specific.** Identity extraction from DLLs (Tier 2), package
   grouping (Tier 3), the manual override (Tier 4) and the provenance model (Tier 5) are
   all local. They apply unchanged to any future backend.
3. **The app has to keep working on 13 August.** The parts that survive are the parts worth
   hardening, and the local compatibility check in particular goes from a nice-to-have to
   the only compatibility signal that exists.
