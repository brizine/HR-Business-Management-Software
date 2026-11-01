import { useState } from "react";
import { Pressable, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, ErrorText, Input, Row, Txt, useTheme } from "./ui";

/** Your balance for each type of time off. */
export function AccruedTimeOffCard({ balances }: { balances: any[] | null }) {
  const t = useTheme();
  return (
    <Card title="Accrued Time Off">
      {balances?.length ? (
        <Row style={{ flexWrap: "wrap", justifyContent: "flex-start", gap: 8 }}>
          {balances.map((b) => (
            <View key={b.policyId} style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, minWidth: 130, flexGrow: 1 }}>
              <Txt style={{ fontSize: 24, fontWeight: "800" }}>{b.balanceHours}h</Txt>
              <Txt muted>{b.name}{b.pendingHours ? ` · ${b.pendingHours}h pending` : ""}</Txt>
            </View>
          ))}
        </Row>
      ) : balances ? <Txt muted>No time off accrued yet.</Txt> : null}
    </Card>
  );
}

const blank = { startDate: "", endDate: "", hours: "8", reason: "" };

/**
 * Request time off (same as the box on the website's employee page): pick a type (showing hours
 * available), dates and hours; your recent requests are listed underneath.
 */
export function RequestTimeOffCard({ balances, onSent, showRecent = true }: { balances: any[] | null; onSent: () => void; showRecent?: boolean }) {
  const t = useTheme();
  const mine = useApi<any[]>(showRecent ? "/pto/requests?mine=true" : null);
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const chosen = policyId ?? balances?.[0]?.policyId ?? null;
  const bal = balances?.find((b) => b.policyId === chosen);
  const available = bal ? Math.round((bal.balanceHours - bal.pendingHours) * 100) / 100 : null;
  const edit = (patch: Partial<typeof blank>) => { setForm({ ...form, ...patch }); setSent(false); };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/pto/requests", { body: { policyId: chosen, startDate: form.startDate, endDate: form.endDate || form.startDate, hours: Number(form.hours), reason: form.reason || undefined } });
      setForm(blank);
      setSent(true);
      mine.reload();
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Request time off">
      <Txt muted style={{ fontSize: 13 }}>Type</Txt>
      <Row style={{ flexWrap: "wrap", justifyContent: "flex-start", gap: 6 }}>
        {balances?.map((b) => (
          <Pressable key={b.policyId} onPress={() => { setPolicyId(b.policyId); setSent(false); }} accessibilityRole="radio" accessibilityState={{ selected: chosen === b.policyId }}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: chosen === b.policyId ? t.primary : t.border, backgroundColor: chosen === b.policyId ? t.primary : "transparent" }}>
            <Txt style={{ color: chosen === b.policyId ? "#fff" : t.text }}>{b.name}</Txt>
          </Pressable>
        ))}
      </Row>
      {available != null && <Txt muted style={{ fontSize: 12 }}>{available}h available</Txt>}
      <Input label="Start date (YYYY-MM-DD)" value={form.startDate} onChangeText={(v) => edit({ startDate: v })} placeholder="2026-12-22" keyboardType="numbers-and-punctuation" maxLength={10} />
      <Input label="End date (YYYY-MM-DD, blank for one day)" value={form.endDate} onChangeText={(v) => edit({ endDate: v })} placeholder="2026-12-23" keyboardType="numbers-and-punctuation" maxLength={10} />
      <Input label="Hours" value={form.hours} onChangeText={(v) => edit({ hours: v })} keyboardType="decimal-pad" />
      <Input label="Reason (optional)" value={form.reason} onChangeText={(v) => edit({ reason: v })} maxLength={500} />
      <ErrorText error={error} />
      <Button title="Submit request" onPress={submit} busy={busy} disabled={!chosen || !form.startDate || !(Number(form.hours) > 0)} />
      {sent && <Txt muted accessibilityLiveRegion="polite">Sent for approval.</Txt>}
      {showRecent && (
        <>
          <Txt style={{ fontWeight: "700", marginTop: 6 }}>Recent requests</Txt>
          {mine.data?.length ? mine.data.slice(0, 5).map(({ request: r, policyName }) => (
            <View key={r.id}>
              <Divider />
              <Row>
                <View style={{ flex: 1 }}>
                  <Txt>{fmtDate(r.startDate)}{r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ""}</Txt>
                  <Txt muted style={{ fontSize: 12 }}>{policyName} · {r.hours}h{r.reason ? ` · ${r.reason}` : ""}</Txt>
                </View>
                <Badge value={r.status} />
              </Row>
            </View>
          )) : mine.data ? <Txt muted>No requests yet.</Txt> : null}
        </>
      )}
    </Card>
  );
}
