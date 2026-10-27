// A day at the register, three ways: by tender, by department, by cashier.
//
// Where the POS has not told us a name, the number is shown as it is —
// "Department 60" — rather than a guess. A wrong label on a real figure
// gets believed, which is worse than no label at all.

import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  ActivityIndicator, StyleSheet, SafeAreaView,
} from 'react-native';
import { getDay, money } from './api';
import { C, S } from './theme';

const TABS = [
  { key: 'tender', label: 'Tender' },
  { key: 'dept',   label: 'Department' },
  { key: 'staff',  label: 'Cashier' },
];

export default function SalesScreen({ onBack }) {
  const [data, setData] = useState(null);
  const [date, setDate] = useState(null);
  const [tab, setTab] = useState('tender');
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (wanted, isRefresh) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const d = await getDay(wanted);
      setData(d);
      setDate(d.date);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { load(null); }, [load]);

  const shift = (days) => {
    if (!date) return;
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    load(d.toISOString().split('T')[0]);
  };

  if (loading) {
    return (
      <SafeAreaView style={st.center}>
        <ActivityIndicator size="large" color={C.red} />
        <Text style={st.loadingText}>Loading the day</Text>
      </SafeAreaView>
    );
  }

  const t = (data && data.totals) || {};
  const gap = Number(t.tender_vs_department) || 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={st.back}>Done</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Sales</Text>
        <View style={{ width: 48 }} />
      </View>

      <View style={st.dayBar}>
        <TouchableOpacity onPress={() => shift(-1)} style={st.dayBtn}>
          <Text style={st.dayBtnText}>‹</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={st.dayText}>{data && data.date ? dayLabel(data.date) : '—'}</Text>
          {data && data.is_latest ? <Text style={st.daySub}>most recent day</Text> : null}
        </View>
        <TouchableOpacity onPress={() => shift(1)} style={st.dayBtn}>
          <Text style={st.dayBtnText}>›</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(date, true)} tintColor={C.red} />}
      >
        {error ? (
          <View style={st.errorBox}><Text style={st.errorText}>{error}</Text></View>
        ) : null}

        {data && data.empty ? (
          <View style={S.card}><Text style={st.muted}>{data.reason}</Text></View>
        ) : null}

        <View style={st.hero}>
          <Text style={st.heroLabel}>Taken that day</Text>
          <Text style={st.heroValue}>{money(t.taken)}</Text>
          <Text style={st.heroNote}>
            Cash {money(t.cash)} · Card {money(t.card)}
            {t.check ? ' · Check ' + money(t.check) : ''}
          </Text>
        </View>

        {/* The register's two views of the same day should agree. */}
        {Math.abs(gap) > 1 ? (
          <View style={st.gapBox}>
            <Text style={st.gapText}>
              Tenders come to {money(t.taken)} but departments come to {money(t.departments)} —
              a gap of {money(Math.abs(gap))}. Something was not captured.
            </Text>
          </View>
        ) : null}

        <View style={st.tabs}>
          {TABS.map((x) => (
            <TouchableOpacity
              key={x.key}
              style={[st.tab, tab === x.key && st.tabOn]}
              onPress={() => { setTab(x.key); setOpen(null); }}
            >
              <Text style={[st.tabText, tab === x.key && st.tabTextOn]}>{x.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'tender' ? (
          <View style={S.card}>
            {(data.tenders || []).map((row) => (
              <Line
                key={row.tender_id}
                name={row.name}
                unnamed={!row.named}
                sub={row.count ? row.count + (row.count === 1 ? ' sale' : ' sales') : null}
                amount={row.amount}
                share={t.taken ? row.amount / t.taken : 0}
                faded={row.bucket === 'other'}
                note={row.bucket === 'other' ? 'not money taken in' : null}
              />
            ))}
          </View>
        ) : null}

        {tab === 'dept' ? (
          <View style={S.card}>
            {!data.naming.departments_named ? (
              <Text style={st.nameHint}>
                Department names are not on file yet, so these show as numbers.
              </Text>
            ) : null}
            {(data.departments || []).map((row) => (
              <Line
                key={row.department_id}
                name={row.name}
                unnamed={!row.named}
                sub={row.items ? row.items + ' items' : null}
                amount={row.sales}
                share={t.departments ? row.sales / t.departments : 0}
              />
            ))}
          </View>
        ) : null}

        {tab === 'staff' ? (
          <View>
            {!data.over_short_available ? (
              <View style={st.noteBox}>
                <Text style={st.noteText}>
                  Over and short is not coming from the register yet, so it is not shown.
                  Pickups and what each drawer declared are real.
                </Text>
              </View>
            ) : null}
            {(data.staff || []).map((s) => (
              <View key={s.employee_id} style={S.card}>
                <TouchableOpacity
                  style={st.staffHead}
                  onPress={() => setOpen(open === s.employee_id ? null : s.employee_id)}
                  activeOpacity={0.7}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[st.staffName, !s.named && st.unnamed]}>{s.name}</Text>
                    <Text style={st.staffSub}>
                      Cash {money(s.cash)}
                      {s.pickup_count ? ' · ' + s.pickup_count + ' pickup' + (s.pickup_count === 1 ? '' : 's') : ''}
                    </Text>
                  </View>
                  <Text style={st.staffAmt}>{money(s.taken)}</Text>
                </TouchableOpacity>

                {open === s.employee_id ? (
                  <View style={st.staffBody}>
                    <Row label="Opening float" value={money(s.float)} />
                    <Row label="Cash taken" value={money(s.cash)} />
                    <Row label="Picked up from the drawer" value={money(s.pickups)} />
                    <Row label="Declared at close" value={money(s.declared)} />
                    {s.over_short !== null && s.over_short !== undefined ? (
                      <Row
                        label={s.over_short < 0 ? 'Short' : 'Over'}
                        value={money(s.over_short)}
                        tone={s.over_short < 0 ? 'bad' : 'good'}
                      />
                    ) : null}

                    <Text style={[S.label, { marginTop: 12, marginBottom: 4 }]}>By tender</Text>
                    {s.tenders.map((x, i) => (
                      <Row key={i} label={x.name} value={money(x.amount)} small />
                    ))}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Line({ name, sub, amount, share, faded, note, unnamed }) {
  const pct = Math.max(0, Math.min(1, share || 0));
  return (
    <View style={[st.line, faded && { opacity: 0.55 }]}>
      <View style={st.lineTop}>
        <View style={{ flex: 1 }}>
          <Text style={[st.lineName, unnamed && st.unnamed]}>{name}</Text>
          {sub || note ? <Text style={st.lineSub}>{note || sub}</Text> : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={st.lineAmt}>{money(amount)}</Text>
          {pct > 0 ? <Text style={st.linePct}>{Math.round(pct * 100)}%</Text> : null}
        </View>
      </View>
      <View style={st.track}><View style={[st.fill, { width: (pct * 100) + '%' }]} /></View>
    </View>
  );
}

function Row({ label, value, tone, small }) {
  return (
    <View style={st.row}>
      <Text style={[st.rowLabel, small && { fontSize: 12.5 }]}>{label}</Text>
      <Text style={[
        st.rowValue, small && { fontSize: 13 },
        tone === 'bad' && { color: C.red }, tone === 'good' && { color: C.green },
      ]}>{value}</Text>
    </View>
  );
}

function dayLabel(iso) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = iso.split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return names[d.getUTCDay()] + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  loadingText: { marginTop: 12, color: C.mute, fontSize: 13 },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  barTitle: { fontSize: 16, fontWeight: '800', color: C.ink },
  back: { fontSize: 15, color: C.blue, fontWeight: '600', width: 48 },

  dayBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
    paddingHorizontal: 8, paddingVertical: 8,
  },
  dayBtn: { paddingHorizontal: 16, paddingVertical: 4 },
  dayBtnText: { fontSize: 26, color: C.blue, fontWeight: '700' },
  dayText: { fontSize: 15, fontWeight: '700', color: C.ink },
  daySub: { fontSize: 11, color: C.mute, marginTop: 1 },

  hero: { backgroundColor: C.ink, borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 11 },
  heroLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: '#9aa3b2', textTransform: 'uppercase' },
  heroValue: { fontSize: 36, fontWeight: '800', color: C.white, letterSpacing: -1.5, marginVertical: 5 },
  heroNote: { fontSize: 12, color: '#9aa3b2' },

  gapBox: { backgroundColor: '#fdf8ec', borderWidth: 1, borderColor: '#f0dcae', borderRadius: 10, padding: 11, marginBottom: 11 },
  gapText: { fontSize: 12.5, color: '#8a6414', lineHeight: 18, fontWeight: '600' },
  noteBox: { backgroundColor: '#f7f9fc', borderRadius: 10, padding: 11, marginBottom: 11 },
  noteText: { fontSize: 12, color: C.mute, lineHeight: 17 },
  nameHint: { fontSize: 12, color: C.mute, marginBottom: 10, lineHeight: 17 },

  tabs: { flexDirection: 'row', backgroundColor: '#e9edf3', borderRadius: 10, padding: 3, marginBottom: 11 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  tabOn: { backgroundColor: C.white },
  tabText: { fontSize: 13.5, fontWeight: '700', color: C.mute },
  tabTextOn: { color: C.ink },

  line: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#f1f3f7' },
  lineTop: { flexDirection: 'row', alignItems: 'flex-start' },
  lineName: { fontSize: 14, fontWeight: '600', color: C.ink },
  lineSub: { fontSize: 11.5, color: C.mute, marginTop: 2 },
  lineAmt: { fontSize: 14.5, fontWeight: '700', color: C.ink },
  linePct: { fontSize: 11, color: C.mute, marginTop: 2 },
  unnamed: { fontStyle: 'italic', color: C.mute },
  track: { height: 3, backgroundColor: '#eef1f6', borderRadius: 2, marginTop: 7 },
  fill: { height: 3, backgroundColor: C.cyan, borderRadius: 2 },

  staffHead: { flexDirection: 'row', alignItems: 'center' },
  staffName: { fontSize: 15, fontWeight: '700', color: C.ink },
  staffSub: { fontSize: 12, color: C.mute, marginTop: 2 },
  staffAmt: { fontSize: 16, fontWeight: '800', color: C.ink },
  staffBody: { marginTop: 12, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10 },

  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { fontSize: 13.5, color: C.mute },
  rowValue: { fontSize: 14, fontWeight: '700', color: C.ink },

  muted: { fontSize: 13, color: C.mute },
  errorBox: { backgroundColor: '#fdf1f1', borderRadius: 10, padding: 11, marginBottom: 11 },
  errorText: { fontSize: 13, color: C.red, fontWeight: '600' },
});
