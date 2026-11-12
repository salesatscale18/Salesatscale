import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ensureUser } from "@/lib/ensure-user";
import { SasRoot } from "@/components/sas";
import { DesignPreview } from "./preview";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Design system — Sales at Scale",
  robots: { index: false, follow: false },
};

/**
 * Living preview of the design system in code (implementation plan P0.3/P0.5).
 * Super admin only, like everything under /sadmin.
 */
export default async function DesignPreviewPage() {
  // proxy.ts already requires sign-in; this is the authorization check.
  const me = await ensureUser();
  if (!me || me.role !== "super_admin") notFound();

  return (
    <SasRoot>
      <DesignPreview />
    </SasRoot>
  );
}
