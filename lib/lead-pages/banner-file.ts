/**
 * The banner file as the seller's browser sees it, before it is sent: its type
 * and size. Pure and dependency-free, so the add/edit form's client part can use
 * it. The server checks the real bytes again (lib/lead-pages/rules.ts checkBanner:
 * magic bytes, at most 2 MB, never SVG).
 */

export const BANNER_MAX_BYTES = 2 * 1024 * 1024;
export const BANNER_ACCEPT = "image/jpeg,image/png,image/webp";
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const EXT = /\.(jpe?g|png|webp)$/i;

export type BannerFileProblem = "wrong_type" | "too_big";

/**
 * Why a chosen file cannot be the banner, or null when it can. The declared
 * type decides; when the browser gives none, the file name's extension does.
 * SVG and every other type is refused.
 */
export function bannerFileProblem(file: { name: string; type: string; size: number }): BannerFileProblem | null {
  const type = (file.type || "").toLowerCase();
  const okType = type ? TYPES.includes(type) : EXT.test(file.name);
  if (!okType) return "wrong_type";
  if (file.size > BANNER_MAX_BYTES) return "too_big";
  return null;
}

/** "820 KB", "1.4 MB": a file size as the seller reads it. */
export function fileSizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`;
}
