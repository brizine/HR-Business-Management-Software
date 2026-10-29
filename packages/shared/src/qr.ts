/**
 * Pulls the asset code out of whatever a QR label contains: the full label
 * URL (https://…/q/CODE), an app link (crewdesk://q/CODE), or a bare code.
 */
export function codeFromScan(data: string): string | null {
  const match = data.trim().match(/\/q\/([0-9A-Za-z-]+)\/?(?:[?#].*)?$/) ?? data.trim().match(/^([0-9A-Za-z]{6,20})$/);
  return match ? match[1] : null;
}
