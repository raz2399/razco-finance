// The screen Raz sees standing on the floor: what is left after everything
// clears, what came in, what needs him, and one button to record a delivery
// before the invoice ends up in a pile.

import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  ActivityIndicator, StyleSheet, SafeAreaView,
} from 'react-native';
import { getOverview, money } from './api';
import { C, S } from './theme';

export default function HomeScreen({ onRecordDelivery, onOpenChecks }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      setData(await getOverview());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={st.center}>
        <ActivityIndicator size="large" color={C.red} />
        <Text style={st.loadingText}>Loading your numbers</Text>
      </SafeAreaView>
    );
  }

  const pos = (data && data.position) || {};
  const tot = (data && data.week_totals) || {};
  const alerts = (data && data.alerts) || [];
  const vendors = (data && data.vendors) || [];
  const checks = (data && data.checks) || [];
  const fresh = (data && data.freshness) || {};
  const negative = Number(pos.after_everything) < 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.red} />
        }
      >
        {error ? (
          <View style={st.errorBox}>
            <Text style={st.errorText}>{error}</Text>
            <Text style={st.errorHint}>Pull down to try again.</Text>
          </View>
        ) : null}

        {fresh.sales_days_behind > 1 ? (
          <View style={st.warnBox}>
            <Text style={st.warnText}>
              Register sales are {fresh.sales_days_behind} days behind. Last day in was{' '}
              {fresh.last_sales_day}.
            </Text>
          </View>
        ) : null}

        {/* the one number that matters standing on the floor */}
        <View style={st.hero}>
          <Text style={st.heroLabel}>Left after everything clears</Text>
          <Text style={[st.heroValue, negative && { color: '#ff6b70' }]}>
            {money(pos.after_everything)}
          </Text>
          <Text style={st.heroNote}>
            {money(pos.in_bank)} in the bank · {money(pos.checks_outstanding)} in checks not cashed
          </Text>
        </View>

        <View style={st.pair}>
          <View style={[S.card, st.half]}>
            <Text style={S.label}>Income this week</Text>
            <Text style={[st.pairValue, { color: C.green }]}>{money(tot.income)}</Text>
          </View>
          <View style={[S.card, st.half, { marginLeft: 10 }]}>
            <Text style={S.label}>Expense this week</Text>
            <Text style={[st.pairValue, { color: C.red }]}>{money(tot.expense)}</Text>
          </View>
        </View>

        <TouchableOpacity style={S.big} onPress={onRecordDelivery} activeOpacity={0.85}>
          <Text style={S.bigText}>Record a delivery</Text>
        </TouchableOpacity>

        <View style={{ height: 11 }} />

        <View style={S.card}>
          <Text style={S.label}>Needs you</Text>
          {alerts.length === 0 ? (
            <Text style={st.ok}>Nothing needs you right now.</Text>
          ) : (
            alerts.map((a, i) => (
              <View
                key={i}
                style={[
                  st.alert,
                  a.level === 'critical' && st.alertCritical,
                  a.level === 'warn' && st.alertWarn,
                ]}
              >
                <Text style={st.alertTitle}>{a.title}</Text>
                {a.detail ? <Text style={st.alertDetail}>{a.detail}</Text> : null}
                {a.action ? <Text style={st.alertAction}>{a.action}</Text> : null}
              </View>
            ))
          )}
        </View>

        <View style={S.card}>
          <View style={st.rowHead}>
            <Text style={S.label}>I owe vendors</Text>
            <Text style={st.rowHeadAmt}>{money(pos.ap_open)}</Text>
          </View>
          {vendors.length === 0 ? (
            <Text style={st.ok}>You do not owe any vendor right now.</Text>
          ) : (
            vendors.map((v, i) => {
              const overdue = v.next_due && v.next_due < data.today && !v.automatic;
              return (
                <View key={i} style={st.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={st.rowName}>
                      {v.name}
                      {v.automatic ? <Text style={st.auto}>  AUTO</Text> : null}
                    </Text>
                    <Text style={st.rowSub}>
                      {v.count} invoice{v.count === 1 ? '' : 's'}
                      {v.automatic
                        ? ' · drafts itself'
                        : v.next_due
                        ? ` · ${overdue ? 'was due' : 'due'} ${v.next_due}`
                        : ''}
                    </Text>
                  </View>
                  <Text style={[st.rowAmt, overdue && { color: C.red }]}>{money(v.amount)}</Text>
                </View>
              );
            })
          )}
        </View>

        <TouchableOpacity style={S.card} onPress={onOpenChecks} activeOpacity={0.7}>
          <View style={st.rowHead}>
            <Text style={S.label}>Checks still out</Text>
            <Text style={st.rowHeadAmt}>{money(pos.checks_outstanding)}</Text>
          </View>
          {checks.length === 0 ? (
            <Text style={st.ok}>Every check you wrote has cleared.</Text>
          ) : (
            checks.slice(0, 5).map((c, i) => (
              <View key={i} style={st.row}>
                <View style={{ flex: 1 }}>
                  <Text style={st.rowName}>
                    #{c.check_number || '?'} {c.payee}
                  </Text>
                  <Text style={st.rowSub}>
                    Written {c.payment_date}
                    {c.days_out !== null ? ` · ${c.days_out} days ago` : ''}
                  </Text>
                </View>
                <Text style={st.rowAmt}>{money(c.amount)}</Text>
              </View>
            ))
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  loadingText: { marginTop: 12, color: C.mute, fontSize: 13 },

  hero: {
    backgroundColor: C.ink, borderRadius: 16, padding: 22,
    alignItems: 'center', marginBottom: 11,
  },
  heroLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: '#9aa3b2', textTransform: 'uppercase' },
  heroValue: { fontSize: 44, fontWeight: '800', color: C.white, letterSpacing: -2, marginVertical: 6 },
  heroNote: { fontSize: 11.5, color: '#9aa3b2' },

  pair: { flexDirection: 'row' },
  half: { flex: 1 },
  pairValue: { fontSize: 24, fontWeight: '800', letterSpacing: -0.8, marginTop: 4 },

  ok: { fontSize: 13.5, color: C.green, fontWeight: '600', paddingVertical: 8 },

  alert: { borderRadius: 10, padding: 12, marginTop: 8, borderLeftWidth: 3, borderLeftColor: C.grey, backgroundColor: '#f7f9fc' },
  alertCritical: { backgroundColor: '#fdf1f1', borderLeftColor: C.red },
  alertWarn: { backgroundColor: '#fdf8ec', borderLeftColor: C.amber },
  alertTitle: { fontSize: 14, fontWeight: '700', color: C.ink },
  alertDetail: { fontSize: 12, color: C.mute, marginTop: 2, lineHeight: 17 },
  alertAction: { fontSize: 11.5, fontWeight: '700', color: C.blue, marginTop: 5 },

  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  rowHeadAmt: { fontSize: 12, fontWeight: '700', color: C.mute },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f3f7' },
  rowName: { fontSize: 14, fontWeight: '600', color: C.ink },
  rowSub: { fontSize: 11.5, color: C.mute, marginTop: 2 },
  rowAmt: { fontSize: 14.5, fontWeight: '700', color: C.ink },
  auto: { fontSize: 9.5, fontWeight: '800', color: C.blue },

  warnBox: { backgroundColor: '#fdf8ec', borderWidth: 1, borderColor: '#f0dcae', borderRadius: 10, padding: 11, marginBottom: 11 },
  warnText: { fontSize: 12, color: '#8a6414', fontWeight: '600', lineHeight: 17 },
  errorBox: { backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca', borderRadius: 10, padding: 11, marginBottom: 11 },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
  errorHint: { fontSize: 11.5, color: C.mute, marginTop: 3 },
});
