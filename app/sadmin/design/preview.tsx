import { STATUS, type StatusObject } from "@/lib/domain/status";
import { formatMoney } from "@/lib/domain/money";
import { ChatMessage, ChatThread } from "@/components/sas/chat";
import { SetupSteps, SideNav } from "@/components/sas/nav";
import { Button, ProvenanceTag, StatusPill } from "@/components/sas/primitives";
import { Banner, DealStateFields, MetricTile, Timeline, WindowTimer } from "@/components/sas/record";
import { t } from "@/lib/i18n";

/** Every design-system component in its states, with fictional sample data. Rendered by /sadmin/design. */
export function DesignPreview() {
  return (
      <div className="sas-shell">
        <SideNav
          mode="seller"
          basePath="/sadmin/design"
          active="overview"
          accountName="Polar Monitoring"
          user={{ name: "Danny Levi", initials: "DL" }}
          counts={{ leads: { value: 142 }, inbox: { value: 3, tone: "human" } }}
        />
        <div className="sas-shell__main">
          <Banner kind="acting" action={<a className="sas-btn sas-btn--sm" href="/sadmin">{t("banner.acting.exit")}</a>}>
            {t("banner.acting", { account: "Polar Monitoring" })}
          </Banner>
          <Banner kind="test">{t("banner.test")}</Banner>
          <main className="sas-shell__content">
            <header>
              <h1 className="sas-display">Design system</h1>
              <p className="sas-small">Trust Blue tokens and components, as used by the seller workspace, admin and buyer pages.</p>
            </header>

            <section className="sas-panel" aria-labelledby="buttons">
              <div className="sas-panel__head"><h2 id="buttons" className="sas-heading">Buttons</h2></div>
              <div className="sas-panel__body" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button variant="primary" icon="file-text">Send order form</Button>
                <Button variant="secondary" icon="calendar">Book meeting</Button>
                <Button variant="takeover" icon="user">Take over chat</Button>
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Cancel quote</Button>
                <Button variant="primary" size="sm">Publish version 8</Button>
                <Button variant="secondary" disabled>Disabled</Button>
              </div>
            </section>

            <section className="sas-panel" aria-labelledby="status">
              <div className="sas-panel__head"><h2 id="status" className="sas-heading">Status language</h2></div>
              <div className="sas-panel__body" style={{ display: "grid", gap: 12 }}>
                {(Object.keys(STATUS) as StatusObject[]).map((object) => (
                  <div key={object} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <span className="sas-label" style={{ minWidth: 120 }}>{object.replace("_", " ")}</span>
                    {Object.keys(STATUS[object]).map((state) => (
                      // `object` is a union here, so its state type narrows to never; the keys come from STATUS itself.
                      <StatusPill key={state} object={object} state={state as never} />
                    ))}
                  </div>
                ))}
              </div>
            </section>

            <div className="sas-metrics">
              <MetricTile label="Leads received" value="214" delta="187 eligible to contact" />
              <MetricTile label="Signed and paid" value="23" delta="+4 vs last period" trend="up" />
              <MetricTile label="Meetings booked" value="17" />
              <MetricTile label="Paid revenue" value={formatMoney(4_820_000, "ILS")} delta={`+ ${formatMoney(414_000, "ILS", { period: "month" })} recurring`} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24 }}>
              <section className="sas-panel" aria-labelledby="chat">
                <div className="sas-panel__head">
                  <h2 id="chat" className="sas-heading">Conversation</h2>
                  <WindowTimer state="open" remaining="18h 20m" />
                </div>
                <ChatThread label="WhatsApp conversation with Rina Cohen">
                  <ChatMessage actor="buyer" who="Rina Cohen" time="09:12">We have 6 walk-in fridges across two kitchens.</ChatMessage>
                  <ChatMessage
                    actor="agent"
                    who="Agent · v7"
                    time="09:12"
                    trace={[{ kind: "tool", label: "check_fit" }, { kind: "knowledge", label: "Installation guide p.3" }]}
                  >
                    Thanks. For two sites you need one gateway per kitchen and 6 sensors. Do both kitchens have Wi-Fi?
                  </ChatMessage>
                  <ChatMessage actor="buyer" who="Rina Cohen" time="09:14" locale="he">כן, בשני המטבחים יש Wi-Fi.</ChatMessage>
                  <ChatMessage actor="system" who="System" time="09:15">Quote Q-2041 v1 created · {formatMoney(486_000, "ILS")}</ChatMessage>
                  <ChatMessage actor="human" who="Danny Levi" time="09:20">Hi Rina, Danny from Polar here. Happy to help with the install date.</ChatMessage>
                </ChatThread>
                <Banner kind="takeover" action={<Button size="sm">{t("banner.takeover.hand_back")}</Button>}>
                  {t("banner.takeover", { name: "Danny Levi" })}
                </Banner>
              </section>

              <section className="sas-panel" aria-labelledby="deal">
                <div className="sas-panel__head"><h2 id="deal" className="sas-heading">Deal state</h2></div>
                <DealStateFields
                  groupLabel="Qualification"
                  fields={[
                    { key: "sites", label: "Sites", value: "2 kitchens", provenance: "buyer" },
                    { key: "fridges", label: "Fridges", value: "6 walk-in", provenance: "buyer" },
                    { key: "wifi", label: "Wi-Fi on site", value: "Yes", provenance: "inferred" },
                    { key: "company", label: "Company", value: "Rina's Kitchen", provenance: "verified" },
                    { key: "budget", label: "Budget" },
                  ]}
                />
                <div className="sas-panel__body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <ProvenanceTag kind="buyer" />
                  <ProvenanceTag kind="inferred" />
                  <ProvenanceTag kind="verified" />
                  <WindowTimer state="closing" remaining="42m" />
                  <WindowTimer state="closed" />
                </div>
              </section>
            </div>

            <section className="sas-panel" aria-labelledby="timeline">
              <div className="sas-panel__head"><h2 id="timeline" className="sas-heading">Timeline</h2></div>
              <Timeline
                label="Lead timeline"
                items={[
                  { id: "1", actor: "system", icon: "user-plus", title: "Lead received from website form", detail: "Consent: website form, 11 Nov 2026 18:02", time: "18:02" },
                  { id: "2", actor: "agent", icon: "message-circle", title: "Opening template sent", detail: "intro_v2 · English", time: "18:05" },
                  { id: "3", actor: "agent", icon: "file-text", title: "Quote Q-2041 v1 sent", detail: `${formatMoney(486_000, "ILS")} + ${formatMoney(18_000, "ILS", { period: "month" })}`, time: "09:15" },
                  { id: "4", actor: "buyer", icon: "pen", title: "Order form signed", detail: "Rina Cohen · form v3", time: "09:31" },
                ]}
              />
            </section>

            <section className="sas-panel" aria-labelledby="steps">
              <div className="sas-panel__head"><h2 id="steps" className="sas-heading">Setup steps</h2></div>
              <div className="sas-panel__body">
                <SetupSteps basePath="/sadmin/design" current="playbook" completed={new Set(["company", "sources", "knowledge", "catalog"])} />
              </div>
            </section>

            <section className="sas-panel" aria-labelledby="admin-nav">
              <div className="sas-panel__head"><h2 id="admin-nav" className="sas-heading">Platform admin navigation</h2></div>
              <div style={{ width: 232, height: 360, display: "flex" }}>
                <SideNav mode="admin" basePath="/sadmin" active="accounts" user={{ name: "Tal Sharon", initials: "TS" }} counts={{ operations: { value: 2, tone: "human" } }} />
              </div>
            </section>
          </main>
        </div>
      </div>
  );
}
