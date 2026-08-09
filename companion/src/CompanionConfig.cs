using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SptarkyCompanion;

/// <summary>
/// The companion's settings, read from <c>config.json</c> beside its DLL.
///
/// Exactly one setting, and it is OFF by default: the overwhelmingly common case is a LAN
/// server where a token is friction with no attacker to stop. Somebody exposing the server more
/// widely can turn it on, and that is a deliberate act rather than a default nobody reads.
/// </summary>
public class CompanionConfig
{
    /// <summary>The header the manager sends its token in. Not the URL — URLs are logged.</summary>
    public const string TokenHeader = "x-sptarky-token";

    [JsonPropertyName("requireToken")]
    public bool RequireToken { get; set; }

    [JsonPropertyName("token")]
    public string Token { get; set; } = "";

    /// <summary>
    /// True when the config is switched on but unusable. Kept separate from
    /// <see cref="RequireToken"/> so the gate can FAIL CLOSED — "protection was asked for and
    /// cannot be provided" must deny, never fall through to open.
    /// </summary>
    [JsonIgnore]
    public bool Misconfigured => RequireToken && string.IsNullOrWhiteSpace(Token);

    /// <summary>
    /// Loads the config from beside the DLL, writing a default one if there is none so the
    /// setting is discoverable without documentation.
    ///
    /// Any failure returns the safe default — off. That is the right direction here: a server
    /// whose config file is corrupt should keep answering its LAN exactly as before rather than
    /// locking out the owner over a stray comma.
    /// </summary>
    public static CompanionConfig Load(out string? problem)
    {
        problem = null;
        try
        {
            string? dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(dir)) return new CompanionConfig();

            string file = Path.Combine(dir, "config.json");
            if (!File.Exists(file))
            {
                var fresh = new CompanionConfig();
                try
                {
                    File.WriteAllText(file, JsonSerializer.Serialize(fresh, new JsonSerializerOptions { WriteIndented = true }));
                }
                catch
                {
                    // A read-only mods folder is not a reason to fail to start.
                }
                return fresh;
            }

            return JsonSerializer.Deserialize<CompanionConfig>(File.ReadAllText(file)) ?? new CompanionConfig();
        }
        catch (Exception ex)
        {
            problem = ex.Message;
            return new CompanionConfig();
        }
    }
}
