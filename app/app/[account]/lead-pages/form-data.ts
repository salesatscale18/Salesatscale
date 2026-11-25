import type { Db } from "@/db/types";
import type { SellerAccount } from "@/db/schema";
import { readOpener } from "@/lib/agent/core/opener";
import { currentPlaybook } from "@/lib/agent/service";
import { defaultConsentFor } from "@/lib/lead-pages/service";
import { listMarkets } from "@/lib/markets/service";
import { blobEnvironment, fileStore } from "@/lib/sources/blob";

/** What the add and edit forms need: the markets, the playbook's opening topics, the consent default and whether banners can be stored here. */
export async function formData(db: Db, account: Pick<SellerAccount, "id" | "market">) {
  const [markets, playbook] = await Promise.all([listMarkets(db, account.id), currentPlaybook(db, account.id)]);
  const opener = readOpener(playbook?.opener);
  const home = markets.find((m) => m.isHome) ?? markets[0] ?? null;
  return {
    markets: markets.map((m) => ({ id: m.id, name: m.name })),
    topics: opener.topics,
    defaultTopic: opener.defaultTopic,
    consentDefault: await defaultConsentFor(db, account, home?.id ?? null),
    // Preview shares the production database and never writes blobs; without a store there is nowhere to keep the image.
    bannerUploads: !!blobEnvironment() && !!fileStore(),
  };
}
