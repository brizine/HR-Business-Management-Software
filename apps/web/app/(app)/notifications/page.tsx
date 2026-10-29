"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, fmtDateTime } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { hrefFor } from "@/lib/links";
import { Empty, PageHead } from "@/components/ui";

export default function Notifications() {
  const router = useRouter();
  const { data, reload } = useApi<{ items: any[]; unread: number }>("/notifications");
  const changed = () => {
    reload();
    window.dispatchEvent(new Event("crewdesk:notifications"));
  };

  const open = async (n: any) => {
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: "POST" });
    changed();
    const href = hrefFor(n.link);
    if (href) router.push(href);
  };

  return (
    <>
      <PageHead title="Notifications" sub={data ? `${data.unread} unread` : undefined}>
        <Link href="/settings/notifications" className="btn">Settings</Link>
        {!!data?.unread && <button className="btn" onClick={() => api("/notifications/read-all", { method: "POST" }).then(changed)}>Mark all as read</button>}
      </PageHead>
      <div className="card">
        {data?.items.length ? (
          <table><tbody>{data.items.map((n) => (
            <tr key={n.id} onClick={() => open(n)} style={{ cursor: "pointer", background: n.readAt ? undefined : "var(--info-bg)" }}>
              <td style={{ width: 12 }}>{!n.readAt && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "var(--primary)" }} />}</td>
              <td><span style={{ fontWeight: n.readAt ? 400 : 700 }}>{n.title}</span><div className="muted">{n.body}</div></td>
              <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(n.createdAt)}</td>
            </tr>
          ))}</tbody></table>
        ) : <Empty>You&apos;re all caught up.</Empty>}
      </div>
    </>
  );
}
