/**
 * GET /api/lp/<key>/banner/<sha256>: a lead page's banner, streamed from the
 * private blob store. The URL changes with the image (its sha256), so it is
 * cached for a year as immutable. Only the page's current banner is served;
 * the type is the one checked by its bytes at upload (never SVG).
 */
import { appDb } from "@/lib/auth/account";
import { pageByKey } from "@/lib/lead-pages/service";
import { fileStore } from "@/lib/sources/blob";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ key: string; sha: string }> }) {
  const { key, sha } = await params;
  if (!/^[0-9a-f]{64}$/.test(sha)) return notFound();
  const found = await pageByKey(appDb, key);
  const banner = found?.page.banner;
  if (!banner || banner.sha256 !== sha) return notFound();
  const store = fileStore();
  if (!store) return notFound();
  let bytes: Uint8Array | null = null;
  try {
    bytes = await store.get(banner.blobPath);
  } catch (e) {
    console.error("[lead-pages] could not read the banner", { pageId: found!.page.id, error: e instanceof Error ? e.message : String(e) });
  }
  if (!bytes) return notFound();
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": banner.contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
