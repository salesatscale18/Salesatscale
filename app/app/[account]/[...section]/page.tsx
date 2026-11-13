import { notFound } from "next/navigation";
import { SELLER_NAV, SETUP_STEPS } from "@/components/sas/nav";
import { requireAccount } from "@/lib/auth/account";
import { t, type MessageKey } from "@/lib/i18n";

/** Which implementation-plan phase builds each workspace section. */
const PHASE: Record<string, string> = {
  "/leads": "P2", "/inbox": "P6", "/orders": "P3", "/meetings": "P7", "/reports": "P9", "/settings": "P6",
  "/setup/sources": "P8", "/setup/knowledge": "P8", "/setup/catalog": "P3",
  "/setup/playbook": "P4", "/setup/order-form": "P5", "/setup/follow-ups": "P7", "/setup/test-lab": "P4",
};

const LABELS: Record<string, MessageKey> = Object.fromEntries([
  ...SELLER_NAV.flatMap((g) => g.items).map((i) => [i.path, i.label] as const),
  ...SETUP_STEPS.map((s) => [s.path, s.label] as const),
]);

/** Placeholder for workspace sections that later phases build. Unknown paths 404. */
export default async function SectionPlaceholder({ params }: { params: Promise<{ account: string; section: string[] }> }) {
  const { account: slug, section } = await params;
  await requireAccount(slug);
  const path = `/${section.join("/")}`;
  const label = LABELS[path];
  if (!label || !PHASE[path]) notFound();
  return (
    <main className="sas-shell__content">
      <section className="sas-panel">
        <div className="sas-panel__body sas-stack-4">
          <h1 className="sas-title">{t("placeholder.title", { section: t(label) })}</h1>
          <p className="sas-small">{t("placeholder.body", { phase: PHASE[path] })}</p>
        </div>
      </section>
    </main>
  );
}
