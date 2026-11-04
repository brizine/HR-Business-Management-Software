"use client";
import { useState } from "react";
import { MENU_LISTS, type MenuKey } from "@crewdesk/shared";
import { MenuEditors } from "./menu-editors";

/**
 * Settings → Layout Editor: set up the drop-down choices used across the site (job titles,
 * departments, role names, statuses…), one list at a time. Changes show everywhere right away.
 */
export function MenuSettingsCard() {
  const [key, setKey] = useState<MenuKey>("jobTitles");
  return (
    <div className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>Settings</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Set up the choices in drop-down menus across the site: job titles, departments, what roles and statuses are called, and more. Changes show everywhere right away, including the mobile app.
        </p>
      </div>
      <div className="row" role="tablist" aria-label="Menus" style={{ flexWrap: "wrap", gap: 6 }}>
        {MENU_LISTS.map((m) => (
          <button key={m.key} type="button" role="tab" aria-selected={key === m.key} className={`btn sm ${key === m.key ? "primary" : ""}`} onClick={() => setKey(m.key)}>
            {m.label}
          </button>
        ))}
      </div>
      <MenuEditors key={key} keys={[key]} />
    </div>
  );
}
