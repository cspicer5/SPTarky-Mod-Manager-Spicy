using Microsoft.AspNetCore.Http;
using SPTarkov.DI.Annotations;
using SPTarkov.Server.Core.Models.Common;
using SPTarkov.Server.Core.Models.Utils;
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
// The injection type is passed only because the constructor is positional and typePriority is
// the third parameter; Scoped is already the default.
[Injectable(InjectionType.Scoped, null, int.MinValue)]
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

    public bool CanHandle(MongoId sessionId, HttpContext context)
    {
        if (!IsCompanionRequest(context)) return false;
        if (!_config.RequireToken) return false;

        // Fail CLOSED: switched on but unusable means refuse, never fall through to open.
        if (_config.Misconfigured) return true;

        return !HasValidToken(context);
    }

    public Task Handle(MongoId sessionId, HttpContext context)
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
