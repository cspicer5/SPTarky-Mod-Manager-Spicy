/**
 * Referers for hotlink-protected catalogue image hosts.
 *
 * The mod browser's thumbnails come from files.sp-mod.com, which answers `403 Nope` to any
 * request that does not carry the catalogue's own Referer. A packaged build loads its UI from
 * file://, which sends no Referer at all, so every <img> in the browser was refused.
 *
 * It did not look like a total failure, which is why it went unnoticed: icons fetched before
 * the host started checking were still being served from Electron's disk cache (the successful
 * response carries `Cache-Control: max-age=2678400` — 31 days), so a long-running install kept
 * showing a shrinking subset while a fresh one would have shown none at all.
 *
 * The rule was measured against the live host, not inferred:
 *
 *   Referer: https://sp-mod.com/     -> 200
 *   Referer: https://sp-mod.com      -> 403   (no trailing slash)
 *   Referer: http://localhost:5173/  -> 403
 *   Referer: file:///                -> 403
 *   (absent)                         -> 403
 *
 * The trailing slash is load-bearing. Anything that "tidies" these values breaks every icon,
 * and the failure is silent — a refused <img> leaves the element in the DOM with its src
 * intact, so only decoded pixels tell you.
 *
 * Matching is by exact hostname. Hotlink protection is there to stop other SITES embedding
 * these images; this is the catalogue's own desktop client showing its listings to someone
 * browsing them, which is the traffic it exists to serve. That is not a reason to attach the
 * header anywhere else, so nothing but these hosts gets it — mod downloads and the API are
 * untouched.
 */
export const IMAGE_HOST_REFERERS: Readonly<Record<string, string>> = Object.freeze({
  "files.sp-mod.com": "https://sp-mod.com/"
});

/**
 * The Referer a given URL needs, or undefined for everything else.
 *
 * An unparseable URL returns undefined rather than throwing: this sits in the path of every
 * request the app makes, so a malformed one must pass through untouched, not break the app.
 */
export function refererForUrl(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return IMAGE_HOST_REFERERS[host];
}
