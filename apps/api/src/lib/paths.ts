import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A folder setting (UPLOAD_DIR, BACKUP_DIR) as a full path. "~" or "~/…" means the account's home
 * folder, so on hosting like SiteGround you can write ~/crewdesk-uploads without looking up the
 * home folder's full path.
 */
export function folderPath(value: string, home = homedir()) {
  const v = value.trim();
  if (v === "~") return home;
  if (v.startsWith("~/")) return join(home, v.slice(2));
  return resolve(v);
}
