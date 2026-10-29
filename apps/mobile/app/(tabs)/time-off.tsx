import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, ErrorText, Input, Row, Screen, Txt, useTheme } from "@/components/ui";

export default function TimeOff() {
  const { can } = useAuth();
  const t = useTheme();
  const balances = useApi<any[]>("/pto/balances");
  const mine = useApi<any[]>("/pto/requests?mine=true");
  const pending = useApi<any[]>(can("manager") ? "/pto/requests?status=pending" : null);
  const [form, setForm] = useState<{ policyId?: string; startDate: string; endDate: string; hours: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = () => { balances.reload(); mine.reload(); pending.reload(); };

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      await api("/pto/requests", { body: { ...form, hours: Number(form.hours), reason: form.reason || undefined } });
      setForm(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = (id: string, status: "approved" | "denied") =>
    api(`/pto/requests/${id}/decide`, { body: { status } }).then(reload, (e) => Alert.alert("Error", e.message));

  return (
    <Screen refreshing={balances.loading} onRefresh={reload}>
      <Row style={{ flexWrap: "wrap", justifyContent: "flex-start" }}>
        {balances.data?.map((b) => (
          <Card key={b.policyId}>
            <Txt style={{ fontSize: 24, fontWeight: "800" }}>{b.balanceHours}h</Txt>
            <Txt muted>{b.name}{b.pendingHours ? ` · ${b.pendingHours}h pending` : ""}</Txt>
          </Card>
        ))}
      </Row>

      {form ? (
        <Card title="Request time off">
          <Txt muted>Type</Txt>
          <Row style={{ flexWrap: "wrap", justifyContent: "flex-start" }}>
            {balances.data?.map((b) => (
              <Pressable key={b.policyId} onPress={() => setForm({ ...form, policyId: b.policyId })}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: form.policyId === b.policyId ? t.primary : t.border }}>
                <Txt>{b.name}</Txt>
              </Pressable>
            ))}
          </Row>
          <Input label="Start date (YYYY-MM-DD)" value={form.startDate} onChangeText={(v) => setForm({ ...form, startDate: v })} placeholder="2026-12-22" />
          <Input label="End date (YYYY-MM-DD)" value={form.endDate} onChangeText={(v) => setForm({ ...form, endDate: v })} placeholder="2026-12-23" />
          <Input label="Hours" value={form.hours} onChangeText={(v) => setForm({ ...form, hours: v })} keyboardType="decimal-pad" />
          <Input label="Reason (optional)" value={form.reason} onChangeText={(v) => setForm({ ...form, reason: v })} />
          <ErrorText error={error} />
          <Button title="Submit request" onPress={submit} busy={busy} disabled={!form.policyId || !form.startDate || !form.endDate || !form.hours} />
          <Button title="Cancel" kind="secondary" onPress={() => setForm(null)} />
        </Card>
      ) : (
        <Button title="Request time off" onPress={() => setForm({ policyId: balances.data?.[0]?.policyId, startDate: "", endDate: "", hours: "8", reason: "" })} />
      )}

      {can("manager") && !!pending.data?.length && (
        <Card title="Needs your approval">
          {pending.data.map(({ request: r, employee, policyName }) => (
            <View key={r.id} style={{ gap: 6 }}>
              <Divider />
              <Txt style={{ fontWeight: "600" }}>{employee.firstName} {employee.lastName}</Txt>
              <Txt muted>{policyName} · {r.hours}h · {fmtDate(r.startDate)} – {fmtDate(r.endDate)}</Txt>
              {r.reason && <Txt muted>"{r.reason}"</Txt>}
              <Row>
                <View style={{ flex: 1 }}><Button title="Approve" onPress={() => decide(r.id, "approved")} /></View>
                <View style={{ flex: 1 }}><Button title="Deny" kind="secondary" onPress={() => decide(r.id, "denied")} /></View>
              </Row>
            </View>
          ))}
        </Card>
      )}

      <Card title="My requests">
        {mine.data?.length ? mine.data.map(({ request: r, policyName }) => (
          <View key={r.id}>
            <Divider />
            <Row>
              <View style={{ flex: 1 }}>
                <Txt>{fmtDate(r.startDate)} – {fmtDate(r.endDate)}</Txt>
                <Txt muted>{policyName} · {r.hours}h</Txt>
              </View>
              <Badge value={r.status} />
            </Row>
          </View>
        )) : <Txt muted>No requests yet.</Txt>}
      </Card>
    </Screen>
  );
}
