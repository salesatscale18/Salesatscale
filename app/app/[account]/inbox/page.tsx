import { redirect } from "next/navigation";

/** The old nav path: the inbox lives at /conversations. */
export default async function InboxRedirect({ params }: { params: Promise<{ account: string }> }) {
  const { account } = await params;
  redirect(`/app/${encodeURIComponent(account)}/conversations`);
}
