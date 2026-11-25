"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MESSAGE_KIND_LABELS, type TemplateChannel } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { DefaultsTab, ImportTemplates, TemplateEditor, useFilteredTemplates, type Template } from "@/components/templates";
import { EmailHistoryTab, EmailTemplatesTab } from "@/components/email-templates";

/** Homeworks' two tabs first (Email Templates, Sent / History), then Crewdesk's own. */
const TABS = [["email", "Email Templates"], ["history", "Sent / History"], ["text", "Text Templates"], ["defaults", "Defaults"]] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Marketing → Templates. Email Templates and Sent / History are laid out like Homeworks, with its
 * drag-and-drop builder; Text Templates keeps the list on the left and the editor on the right.
 */
export default function TemplatesPage() {
  const { can } = useAuth();
  const isAdmin = can("admin", "customers");
  const router = useRouter();
  const params = useSearchParams();
  const tab = ((params.get("tab") as Tab) || "email") as Tab;
  const list = useApi<Template[]>("/templates");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [q, setQ] = useState("");
  const [who, setWho] = useState("");
  const [dirty, setDirty] = useState(false);
  const channel: TemplateChannel = tab === "text" ? "text" : "email";
  const shown = useFilteredTemplates(list.data ?? [], channel, q, who);
  const current = selected && selected !== "new" ? list.data?.find((t) => t.id === selected) ?? null : null;

  // Open the first template when a list tab opens.
  useEffect(() => {
    if (tab === "text" && list.data && (!selected || (selected !== "new" && !list.data.some((t) => t.id === selected && t.channel === channel)))) {
      setSelected(list.data.find((t) => t.channel === channel)?.id ?? "new");
    }
  }, [tab, list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const leave = () => !dirty || confirm("You have changes that aren't saved. Leave them?");
  const go = (t: Tab) => { if (leave()) { setDirty(false); setSelected(null); router.replace(`/templates?tab=${t}`); } };
  const choose = (id: string | "new") => { if (id !== selected && leave()) { setDirty(false); setSelected(id); } };

  return (
    <div className="hw" data-lkeep="">
      <PageHead title={tab === "text" ? "Text Templates" : tab === "defaults" ? "Templates" : "Email Templates"}>
        {isAdmin && <ImportTemplates onDone={list.reload} />}
      </PageHead>
      <nav className="hwd-tabs" aria-label="Templates">
        {TABS.map(([k, label]) => <button key={k} type="button" aria-current={tab === k ? "page" : undefined} className={tab === k ? "active" : ""} onClick={() => go(k)}>{label}</button>)}
      </nav>
      <ErrorBox error={list.error} />
      {tab === "email" && list.data && <EmailTemplatesTab list={list.data} reload={list.reload} />}
      {tab === "history" && <EmailHistoryTab />}
      {tab === "defaults" && list.data && <DefaultsTab templates={list.data} canEdit={isAdmin} />}
      {tab === "text" && list.data && (
        <div className="tpl-layout" data-lkeep="">
          <aside className="card tpl-list">
            <div className="stack" style={{ gap: 6 }}>
              <button type="button" className="btn primary" onClick={() => choose("new")}>New {channel} template</button>
              <input type="search" placeholder="Find a template" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a template" />
              <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Show">
                <option value="">All</option><option value="customer">To customers</option><option value="internal">To your team</option>
                <option value="system">Crewdesk&apos;s own</option><option value="homeworks">From Homeworks</option>
              </select>
            </div>
            <ul className="tpl-items">
              {shown.map((t) => (
                <li key={t.id}>
                  <button type="button" className={selected === t.id ? "on" : ""} onClick={() => choose(t.id)}>
                    <span className="tpl-item-name">{t.name}</span>
                    <span className="tpl-item-meta">
                      {t.audience === "internal" ? "Team" : "Customers"}
                      {t.system ? " · Crewdesk" : ""}
                      {t.usedFor.length ? ` · ${t.usedFor.map((k) => MESSAGE_KIND_LABELS[k].toLowerCase()).join(", ")}` : ""}
                    </span>
                  </button>
                </li>
              ))}
              {!shown.length && <li><Empty>No templates match.</Empty></li>}
            </ul>
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>{shown.length} of {list.data.filter((t) => t.channel === channel).length}</p>
          </aside>
          {selected && (
            <TemplateEditor
              key={`${channel}-${selected}`}
              template={current}
              channel={channel}
              onDirty={setDirty}
              onSaved={(t) => { setDirty(false); list.reload(); setSelected(t.id); }}
              onDeleted={() => { setDirty(false); setSelected(null); list.reload(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}
