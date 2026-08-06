# Mod presets — design (v1.2.1)

A preset is a named, shareable definition of a working mod setup. The goal is not "export a
list" — that already exists and is nearly useless on its own — but **"my friend runs one
action and can play on my server."**

Two constraints shape everything below, and they pull in the same direction:

1. **It must not depend on Forge.** Forge shuts down on 2026-08-10. A preset that names mods
   and expects you to go and find them is a treasure hunt with no map.
2. **It must lower the barrier to entry.** That is the whole point. Anything that ends in
   "now go download these 54 mods yourself" has failed.

Together these mean a preset has to be able to **carry the mods**, not merely list them.

---

## What we already have

Most of this feature is assembled; it just has not been pointed at a preset yet.

| Need | Already exists |
|---|---|
| Read a full mod list with identity and version | `scanMods`, `exportModListData` |
| Reconcile a wanted list against an install | `buildServerSyncReport` (server), `buildParityReport` (headless) |
| Copy a mod's COMPLETE file set between installs | `copyClientModToHeadless` — folder or loose dll, companion folder, patchers, config |
| Install into an instance | `installModFromArchive`, `finalizeUnrecognizedInstall` |
| Identity that survives Forge | GUIDs in the local registry + `data/forge-directory.json` |

**A preset is a virtual instance.** Applying one is the same reconciliation the app already
does against a live server, with a static snapshot on the other side.

The genuinely new work is storage, transport, and payload handling.

---

## Sizing, measured

From the reference install (54 mods):

| | Entries | Size |
|---|---|---|
| `BepInEx/plugins` | 31 | 1.25 GB |
| `SPT/user/mods` | 28 | 16.57 GB |
| **Total** | 54 | **17.8 GB** |

Largest single mods: `WTT-ContentBackport` 4.76 GB, `WTT-Armory` 4.54 GB, `ISB-Aishi` 2.53 GB.
These are the ones the server reports as `IsBundleMod: true` — Unity asset bundles.

Three consequences:

- **Deduplication is mandatory, not an optimisation.** Storing payloads per preset would cost
  17.8 GB for the first preset and roughly that again for the second, even if they share 90%
  of their mods.
- **Cloud-synced folders cannot host full presets.** Dropbox's free tier is 2 GB. A LAN share
  or VPN-reachable folder can, and that is the chosen backend.
- **Manifest-only presets must remain a first-class option.** At ~40 KB they are what you send
  someone to ask "are we running the same thing?", and they work over any transport.

---

## Storage layout

The store is a folder. It may be a Windows share (`\\host\SPT-Presets`), a VPN-reachable
path, or a local directory. The app only ever does file I/O; distribution and access control
belong to the share, which is why this works unchanged on LAN, VPN or Syncthing.

```
<store>/
  store.json                     name, schema version, write policy
  presets/
    stable-coop.json             manifest — small, human-readable
    hardcore-nights.json
  mods/
    WTT-Armory@2.0.5/            payload, shared by every preset that uses it
      user/mods/WTT-Armory/...
    SAIN@4.4.3/
      BepInEx/plugins/SAIN/...
      BepInEx/config/me.sol.sain.cfg
    DrakiaXYZ-BigBrain@1.4.0/
      BepInEx/plugins/DrakiaXYZ-BigBrain.dll
```

**One file per preset, never a shared index.** A rebuilt-on-read index cannot be corrupted by
two people writing at once, and sync tools that resolve conflicts by duplicating files cannot
damage anything.

**Payloads keyed `<name>@<version>`, stored once.** Adding a second preset costs only the
mods it does not share. Payloads mirror the layout they came from (`BepInEx/…`, `user/…`), so
applying one is a copy, not a transformation.

### `store.json`

```jsonc
{
  "schema": 1,
  "name": "Spicy Co-op",
  "writePolicy": "shared",   // "curated" = only the owner publishes; "shared" = anyone may
  "owner": "cspicer5",
  "createdAt": "2026-08-06T00:00:00Z"
}
```

The policy lives in the store rather than in each client's settings, so every client agrees
on it. It is a convention, not a security control — anyone with write access to the folder
can change it. Real enforcement is the share's own permissions, which is the right place for
it.

### A preset manifest

```jsonc
{
  "schema": 1,
  "id": "stable-coop",
  "name": "Stable Co-op",
  "description": "What the Tuesday group runs.",
  "author": "cspicer5",
  "updatedAt": "2026-08-06T00:00:00Z",
  "sptVersion": "4.0.13",
  "hasPayloads": true,          // false = manifest-only, apply can only report
  "mods": [
    {
      "name": "SAIN",
      "guid": "me.sol.sain",
      "version": "4.4.3",
      "type": "client",
      "enabled": true,
      "loadOrder": 99,
      "payload": "mods/SAIN@4.4.3",
      "sizeBytes": 41234567,
      "license": "MIT",
      "sourceUrl": "https://github.com/ArchangelWTF/SAIN",
      "required": true          // false = "nice to have", not needed to join
    }
  ]
}
```

`license` and `sourceUrl` are recorded because both are already available — from
`/launcher/server/loadedServerMods` and from `data/forge-directory.json` — and because
someone publishing a 17.8 GB bundle of other people's work should be able to see what they
are sharing. Several installed mods carry `CC-BY-NC-ND` and one is `PUSL`. Verbatim
redistribution among a private group is a very different thing from publishing, but the app
should surface the licences at publish time rather than pretend it does not know.

---

## Flows

### Publish

1. Scan the instance (`scanMods`).
2. Choose which mods to include, and mark each required or optional.
3. For each mod not already in `mods/<name>@<version>/`, copy its complete file set —
   generalising `copyClientModToHeadless`, which already handles folders, loose DLLs with
   companion folders, patchers and config.
4. Write `presets/<id>.json`.

Copy into a temp directory in the store and rename into place, so a partially written payload
is never visible to someone applying at the same moment.

### Apply

1. Read the manifest.
2. Reconcile against the target instance — the existing engine, GUID first, name as fallback.
3. Show the same shape of report the server pane shows: **install these, update these, you
   have these extra**.
4. On confirmation:
   - payload present → copy in (no network at all);
   - no payload, Forge alive → the existing Forge install path;
   - no payload, no Forge → show `sourceUrl` and let the user fetch it.
5. Apply enabled/disabled state and load order.

Never destructive by default: a mod present locally but absent from the preset is reported,
not removed, unless the user explicitly asks for an exact match.

### Verify

Applying and then re-reconciling should come back clean. Worth having as its own action —
"does my install match this preset?" is the question people actually ask before a session.

---

## Phasing

**Phase 1 — presets, local.** Data model, save from the current instance, apply with the
reconciliation report, verify. No store, no sharing. Immediately useful and needs no
decisions from anyone else.

**Phase 2 — folder store, manifests only.** `store.json`, publish and browse, write policy,
apply from a shared manifest. Small files, quick to get right.

**Phase 3 — payloads.** The deduped `mods/` store, copy-on-publish, apply-from-payload,
progress reporting for multi-GB copies, resume/verify on interrupted copies. This is the part
that removes Forge from the equation entirely.

**Phase 4 (later) — other transports.** An HTTP/WebDAV backend behind the same interface if
the folder ever stops being enough. Explicitly out of scope for v1.2.1.

---

## Risks and open questions

- **Interrupted multi-GB copies.** A 4.7 GB mod copied halfway must not look complete. Write
  to a temp name and rename on completion; record a size or hash in the manifest and verify
  before trusting a payload.
- **Disk cost on the store.** 17.8 GB for one full preset. The app should show the store's
  size and what a publish would add before doing it.
- **Version identity — largely addressed.** `<name>@<version>` used to be unsound because a
  mod's declared version is not evidence of which build you have: `fika-server` declares
  2.0.9 whichever one you installed. The app now **records what it actually installed**
  (Forge's version, a release tag, or the archive filename) and prefers that over the mod's
  own claim, falling back only when a fingerprint shows the files changed afterwards. So a
  preset built by this app carries real versions.

  Two gaps remain. Mods installed before this existed have no record — 39 of 39 on the
  reference install — so their versions are still whatever they declare. And a mod dropped
  into the folder by hand never had a record to begin with. A content hash in the payload
  manifest closes both, and is worth doing in Phase 3 since payloads are being copied
  anyway.
- **Trust.** Applying a preset copies executable code from a shared folder onto your machine.
  That is exactly what installing a mod already does, but a shared store makes it one click,
  so the source of a preset should always be visible.
- **SPT version drift.** A preset records the SPT version it was built against. Applying it to
  a different SPT version should warn loudly — the same check the server pane already makes.
