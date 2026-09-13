using Microsoft.AspNetCore.Http;
using SPTarkov.DI.Annotations;
using SPTarkov.Server.Core.Models.Common;
#if NET10_0_OR_GREATER
// 4.1 moved ISptLogger out of Server.Core into SPTarkov.Common. Nothing about the type changed,
// only where it lives, so this is a using and not a shim.
using SPTarkov.Common.Models.Logging;
#else
using SPTarkov.Server.Core.Models.Utils;
#endif
using SPTarkov.Server.Core.Servers.Http;

namespace SptarkyCompanion;

/// <summary>
/// Refuses companion requests that have not presented the configured token.
///
/// <para>
/// It is an <see cref="IHttpListener"/> rather than a check inside the routes because a route
/// action never sees the request: its signature is (url, IRequestData, sessionId, output), with
/// no headers and no query string. A listener gets the whole HttpContext.
/// </para>
/// <para>
/// The other candidate was an ISerializer, and it was rejected on evidence:
/// <c>SptHttpListener.SendResponse</c> skips serializer selection entirely when the CALLER sends
/// <c>responsecompressed: 0</c>, so a gate living there could be stepped around by anyone who
/// sets a header.
/// </para>
/// <para>
/// This claims ONLY the requests it intends to refuse. <c>HttpServer</c> dispatches to the first
/// listener whose CanHandle returns true, so declining leaves an authorised request to travel
/// the ordinary path into the routers — the working, tested code is untouched by the presence of
/// this class.
/// </para>
/// </summary>
// The priority is the whole reason this works, and it is NOT decoration. InjectAll orders
// registrations by TypePriority ASCENDING, and IEnumerable<IHttpListener> comes out in that
// order, and HttpServer takes the FIRST listener whose CanHandle says yes. SptHttpListener
// declares int.MaxValue — but so does the attribute's own default, so a plain [Injectable] TIES
// with it and loses on discovery order, because SPT's assembly is scanned before any mod's.
// That was measured, not assumed: with a plain attribute the token was required, the gate was
// constructed, and unauthenticated requests still returned 200.
// Two separate traps live in this one line, and the second one stops the server dead.
//
// typePriority is passed BY NAME because its position moved: 4.0 declared
// (InjectionType, Type typeOverride, int typePriority) and 4.1 removed typeOverride, so the third
// slot became the second. Positionally this would either not compile or, worse, bind int.MinValue
// to the wrong parameter.
//
// The injection type is now passed NOT AT ALL, and that is deliberate. 4.1 inserted
// HostedService at 0 in the InjectionType enum, shifting Singleton/Transient/Scoped up by one —
// so the NAMES are stable and compile against both, while the VALUES are not. SptHttpListener is
// declared 2 in both versions, which reads as Scoped in 4.0 and Transient in 4.1. Naming
// InjectionType.Scoped therefore tracked SPT on 4.0 and diverged from it on 4.1, and 4.1 also
// turned on DI scope validation: a Scoped IHttpListener consumed by the singleton HttpServer
// fails validation and the server REFUSES TO START. Not a warning, not a broken route — no
// server at all, for everyone who installed this.
// The attribute's own default is 2 in both versions, which is exactly what SptHttpListener uses
// in each. Omitting it is how this stays correct through a shift like that one.
[Injectable(typePriority: int.MinValue)]
public class SptarkyAuthGate : IHttpListener
{
    private readonly CompanionConfig _config;
    private readonly ISptLogger<SptarkyAuthGate> _logger;

    public SptarkyAuthGate(ISptLogger<SptarkyAuthGate> logger)
    {
        _logger = logger;
        _config = CompanionConfig.Load(out string? problem);

        if (problem != null)
        {
            _logger.Warning($"[Spicy's Tarky Mod Manager Companion] config.json could not be read ({problem}); continuing with the token OFF.");
        }
        else if (_config.Misconfigured)
        {
            // Asked for protection that cannot be given: say so loudly, because the gate is
            // about to refuse everything and the owner needs to know why.
            _logger.Error("[Spicy's Tarky Mod Manager Companion] requireToken is on but no token is set — REFUSING all companion requests until config.json has one.");
        }
        else if (_config.RequireToken)
        {
            _logger.Success("[Spicy's Tarky Mod Manager Companion] token required. Managers must send the x-sptarky-token header.");
        }
    }

    // 4.1 changed both halves of this interface: CanHandle lost its sessionId, and Handle became
    // HandleAsync with a CancellationToken. Neither the decision nor the refusal changed, so they
    // stay in one place below and only the entry points differ. Getting this wrong is quiet — a
    // listener that does not match the interface is simply never consulted, and every request
    // sails past with 200.
#if NET10_0_OR_GREATER
    public bool CanHandle(HttpContext context) => ShouldRefuse(context);

    public Task HandleAsync(MongoId sessionId, HttpContext context, CancellationToken cancellationToken) => Refuse(context);
#else
    public bool CanHandle(MongoId sessionId, HttpContext context) => ShouldRefuse(context);

    public Task Handle(MongoId sessionId, HttpContext context) => Refuse(context);
#endif

    private bool ShouldRefuse(HttpContext context)
    {
        if (!IsCompanionRequest(context)) return false;
        if (!_config.RequireToken) return false;

        // Fail CLOSED: switched on but unusable means refuse, never fall through to open.
        if (_config.Misconfigured) return true;

        return !HasValidToken(context);
    }

    private static Task Refuse(HttpContext context)
    {
        // 401 rather than 404, so the manager can tell "needs a token I do not have" from
        // "no companion installed here". They have completely different fixes, and readCapabilities
        // on the manager side already reports them differently.
        context.Response.StatusCode = 401;
        context.Response.ContentType = "application/json";
        return context.Response.WriteAsync("{\"err\":401,\"errmsg\":\"This SPTarky companion requires a token.\"}");
    }

    private static bool IsCompanionRequest(HttpContext context) =>
        context.Request.Path.Value?.StartsWith("/sptarky/", StringComparison.OrdinalIgnoreCase) == true;

    private bool HasValidToken(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue(CompanionConfig.TokenHeader, out var supplied)) return false;
        string? value = supplied.ToString();
        if (string.IsNullOrEmpty(value)) return false;

        // Fixed-time comparison. The tokens are long-lived and an attacker can retry freely, so
        // leaking their length or a matching prefix through timing is worth not doing.
        return FixedTimeEquals(value, _config.Token);
    }

    private static bool FixedTimeEquals(string a, string b)
    {
        byte[] left = System.Text.Encoding.UTF8.GetBytes(a);
        byte[] right = System.Text.Encoding.UTF8.GetBytes(b);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(left, right);
    }
}
