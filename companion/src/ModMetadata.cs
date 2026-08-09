using SPTarkov.Server.Core.Models.Spt.Mod;
// Aliased rather than imported wholesale: `Version` and `Range` both collide with System
// types that implicit usings bring in, and the resulting error names neither culprit.
using SemVersion = SemanticVersioning.Version;
using SemRange = SemanticVersioning.Range;

namespace SptarkyCompanion;

/// <summary>
/// Identity of the SPTarky server companion.
///
/// Every property on <see cref="AbstractModMetadata"/> is abstract, so all eleven must be
/// supplied — there are no defaults to inherit and omitting one will not compile.
///
/// This mod exists because a stock SPT server cannot answer three questions the SPTarky Mod
/// Manager needs, established by probing a live 4.0.13 server:
///
///   * client mods — the server never sees the client's BepInEx folder, and no endpoint
///     exposes one;
///   * true installed versions — /launcher/server/loadedServerMods reports what each mod
///     DECLARES, which is wrong whenever an author forgets to bump it;
///   * mod files — /files/ serves bundles only.
///
/// It is read-only by construction. There are no routes that write, install or delete, so it
/// cannot be driven to do more than report — the restriction is structural rather than a
/// setting somebody can widen.
/// </summary>
public record SptarkyCompanionMetadata : AbstractModMetadata
{
    public override string ModGuid { get; init; } = "com.sptarky.companion";
    public override string Name { get; init; } = "SPTarky Companion";
    public override string Author { get; init; } = "cspicer5";
    public override List<string> Contributors { get; init; } = [];

    /// <summary>
    /// Kept in step with the protocol the manager negotiates, NOT with the manager's own
    /// version. The two are released separately and a server is rarely updated in lockstep
    /// with the clients that talk to it.
    /// </summary>
    public override SemVersion Version { get; init; } = new SemVersion(1, 0, 0);

    /// <summary>
    /// Everything this mod touches — the mod folders, the ledger files, the bundle cache —
    /// has been stable across 4.0 and 4.1, including the SPT_Runtime rename, because roots
    /// are resolved by marker rather than by name.
    /// </summary>
    public override SemRange SptVersion { get; init; } = new SemRange(">=4.0.0");

    public override List<string> Incompatibilities { get; init; } = [];
    public override Dictionary<string, SemRange> ModDependencies { get; init; } = [];
    public override string Url { get; init; } = "https://github.com/cspicer5/SPTarky-Mod-Manager-Spicy";

    /// <summary>Ships no bundles; it only ever reports on other mods'.</summary>
    public override bool? IsBundleMod { get; init; } = false;

    public override string License { get; init; } = "MIT";
}
