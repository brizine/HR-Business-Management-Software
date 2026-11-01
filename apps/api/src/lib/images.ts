/** Uploaded images (employee photos, the company logo): up to 5 MB, JPEG/PNG/WebP only. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The image type from the file's first bytes (not its name or claimed type), or null if it isn't one we accept. */
export function imageType(b: Buffer) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
