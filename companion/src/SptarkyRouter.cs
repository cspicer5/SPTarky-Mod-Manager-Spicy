using System.Text.Json.Serialization;
using SPTarkov.DI.Annotations;
using SPTarkov.Server.Core.DI;
using SPTarkov.Server.Core.Utils;
using SPTarkov.Server.Core.Models.Spt.Mod;
using SPTarkov.Server.Core.Models.Utils;

namespace SptarkyCompanion;

/// <summary>
/// The companion's HTTP surface.
///
/// Every route is a GET that reads and returns; there is deliberately no route that writes,
/// installs or removes anything. That is the security model — not a permission to be checked,
/// but an absence of anything to call.
///
/// <para>
/// A route action MUST return an already-serialized JSON <c>string</c>. SPT's
/// <c>HttpRouter.HandleRoute</c> takes the action's result and casts it with <c>as string</c>;
/// return a POCO and that cast silently yields null, which the listener reports as
/// <c>UNHANDLED RESPONSE</c> — indistinguishable from a route that was never registered.
/// Serialize through <see cref="HttpResponseUtil"/> and return the string.
/// </para>
/// </summary>
[Injectable]
public class SptarkyRouter : StaticRouter
{
    /// <summary>
    /// Bumped only when the contract changes in a way an older manager would MISREAD. A
    /// manager seeing a higher number than it knows refuses to use the companion rather than
    /// guessing at fields whose meaning may have moved.
    /// </summary>
    private const int Protocol = 1;

    private const string CompanionVersion = "1.0.0";

    /// <summary>
    /// What this build can do, asked about BY NAME. The manager checks for a capability rather
    /// than comparing version numbers, so routes can ship one at a time without the client
    /// having to know this mod's release history.
    /// </summary>
    private static readonly List<string> Capabilities = ["manifest", "files"];

    public SptarkyRouter(
        JsonUtil jsonUtil,
        HttpResponseUtil httpResponseUtil,
        IReadOnlyList<SptMod> loadedMods,
        ISptLogger<SptarkyRouter> logger)
        : base(
            jsonUtil,
            [
                new RouteAction(
                    "/sptarky/version",
                    // Signature fixed by SPT: (url, IRequestData info, MongoId sessionId, string? output).
                    // This route takes no input at all, hence the discards.
                    //
                    // NoBody serializes the object plainly. The alternative, GetBody, wraps it as
                    // {err, errmsg, data} — the shape the game client expects. Plain is the right
                    // choice here because SPT answers an UNKNOWN route with HTTP 200 and a body of
                    // {"err":404,...}. Keeping `err` out of a real response means the manager can
                    // tell "no companion installed" from "companion answered" by shape alone.
                    (_, _, _, _) => new ValueTask<object>(httpResponseUtil.NoBody(new VersionResponse
                    {
                        Version = CompanionVersion,
                        Protocol = Protocol,
                        Capabilities = Capabilities
                    }))),

                new RouteAction(
                    "/sptarky/manifest",
                    // Read fresh on every request rather than cached at startup: mods are
                    // installed and removed while the server is up, and a manifest that answered
                    // from a snapshot taken at boot would quietly disagree with the disk.
                    (_, _, _, _) => new ValueTask<object>(httpResponseUtil.NoBody(
                        ManifestBuilder.Build(InstallLayout.Detect(), loadedMods, Protocol, CompanionVersion))))
            ])
    {
        // Said out loud at startup, so "is the companion actually running?" is answered by
        // the server's own log rather than by probing it from somewhere else.
        logger.Success(
            $"[Spicy's Tarky Mod Manager Companion] active — v{CompanionVersion}, protocol {Protocol}. " +
            $"Serving /sptarky/version, /sptarky/manifest, {SptarkyFileRouter.ListRoute}, {SptarkyFileRouter.DataRoute}");
    }
}

/// <summary>
/// What <c>/sptarky/version</c> returns.
///
/// <c>Capabilities</c> is a list of names rather than booleans or an inference from the
/// version number, so the manager asks "can you do X" instead of "are you new enough to do X"
/// — which keeps this mod's release history out of the client entirely.
///
/// Names are pinned with <see cref="JsonPropertyNameAttribute"/> so the wire format does not
/// depend on whatever casing policy SPT's shared serializer happens to be configured with.
/// </summary>
public class VersionResponse
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("protocol")]
    public int Protocol { get; set; }

    [JsonPropertyName("capabilities")]
    public List<string> Capabilities { get; set; } = [];
}
