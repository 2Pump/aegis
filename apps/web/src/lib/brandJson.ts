import { brandJson, hasLegacyBrand } from '@aegis/glyphs';

/**
 * The one way the site reads a published JSON file that can carry human-readable text written before the rebrand:
 * legacy "AEGIS"/"Aegis" in string values is shown as PHROURAX/Phrourax. Keys, lowercase identifiers (`aegis-…` kinds,
 * `record.aegis`) and numbers are never touched, and the file itself is never changed.
 */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  const j: unknown = JSON.parse(text);
  return hasLegacyBrand(text) ? brandJson(j) : j;
}
