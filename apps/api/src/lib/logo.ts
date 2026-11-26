import { isLogoSize, type LogoSize } from "@crewdesk/shared";
import { storage } from "./storage";

/**
 * Logos uploaded since Crewdesk fits them in the browser (blank border trimmed, sized for where
 * they're used) come as two files: the full one under the company's logo key, for print and
 * designed emails, and a smaller one beside it for screens. Older logos are the one file.
 */
export const FITTED = "/logo-fit-";
export const logoIsFitted = (key: string | null | undefined) => !!key && key.includes(FITTED);
export const smallLogoKey = (key: string) => `${key}-small`;

/** The logo's bytes at the size asked for ("small" for screens); the full one when there is no smaller copy. */
export async function readLogo(key: string, size?: unknown): Promise<Buffer> {
  const want: LogoSize = isLogoSize(size) ? size : "full";
  if (want === "small" && logoIsFitted(key)) {
    try { return await storage.get(smallLogoKey(key)); } catch { /* the small copy is missing: the full one still serves */ }
  }
  return storage.get(key);
}
