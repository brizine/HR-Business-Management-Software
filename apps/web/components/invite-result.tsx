"use client";
import { useState } from "react";

/** After hiring, adding or re-inviting someone: says whether the invite was emailed, and offers the link to share. */
export function InviteResult({ invite, name, email }: { invite: { emailed: boolean; link: string } | null; name: string; email: string }) {
  const [copied, setCopied] = useState(false);
  if (!invite) return <p className="muted">No invite sent. You can send one from {name}&apos;s profile.</p>;
  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        {invite.emailed
          ? <>✓ Invite emailed to <strong>{email}</strong>. The link works for 7 days.</>
          : <>Email isn&apos;t set up on the server, so send {name} this link yourself (text it, or email it). It works for 7 days.</>}
      </p>
      <div className="row">
        <input readOnly value={invite.link} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} />
        <button className="btn" onClick={() => navigator.clipboard.writeText(invite.link).then(() => setCopied(true))}>{copied ? "Copied" : "Copy link"}</button>
      </div>
    </div>
  );
}
