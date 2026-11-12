import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ensureUser } from "@/lib/ensure-user";
import { AdminShell } from "./admin-shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Super Admin — Sales at Scale",
  robots: { index: false, follow: false },
};

const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Platform admin home. Shows users until Admin › Activity is built (P9). */
export default async function SuperAdminPage() {
  // proxy.ts already requires sign-in; this is the authorization check.
  const me = await ensureUser();
  if (!me || me.role !== "super_admin") notFound();

  const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));

  return (
    <AdminShell me={me}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <h1 className="sas-title">Users</h1>
          <span className="sas-small">
            {allUsers.length} user{allUsers.length === 1 ? "" : "s"}
          </span>
        </header>
        <section className="sas-panel" style={{ overflowX: "auto" }}>
          <table className="sas-table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Joined (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {allUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.email ?? "—"}</td>
                  <td>{[u.firstName, u.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td>{u.role}</td>
                  <td className="sas-num">{dateFmt.format(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </AdminShell>
  );
}
