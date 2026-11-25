import type { NextConfig } from "next";

/**
 * Security headers (hardening cycle). A full Content-Security-Policy needs the
 * Clerk and font origins listed and nonces for Next's inline scripts; until
 * then the CSP only covers what cannot break the app: no framing, no <base>
 * hijacking, no plugins. The microphone is allowed for this site only
 * (voice calls in the test lab and the buyer chat); never for embedded origins.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Setup › Sources uploads files to a server action (10 MB per file; Vercel itself caps a request at 4.5 MB).
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Buyer links carry a personal token: never send it on in a Referer, never index.
      // The lead page hand-over (/h/<token>) too: its token opens the buyer's new chat for 30 minutes.
      ...["/f/:path*", "/chat/:path*", "/h/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      })),
      // The hosted lead form: never indexed, never cached (each render carries a fresh form-timing token).
      {
        source: "/p/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      // The lead form snippet (slice b, public/lp/v1.js): cached at the edge, backward compatible forever.
      { source: "/lp/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" }] },
    ];
  },
};

export default nextConfig;
