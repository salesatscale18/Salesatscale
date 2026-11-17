"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { setSimulatorSettings } from "@/lib/simulator/service";

/** Settings › Simulation: both switches. Re-checks access on the server; audited in the service. */
export async function saveSimulatorSettingsAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  await setSimulatorSettings(appDb, actorOf(access), access.account.id, {
    simulateWhatsappRules: form.get("simulateRules") === "on",
    allowSimulatedBuyers: form.get("allowSimulated") === "on",
  });
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(`/app/${access.account.slug}/settings?section=simulation&saved=simulation`);
}
