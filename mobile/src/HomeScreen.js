// The screen Raz sees standing on the floor: what is left after everything
// clears, what came in, what needs him, and one button to record a delivery
// before the invoice ends up in a pile.

import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  ActivityIndicator, StyleSheet, SafeAreaView,
} from 'react-native';
import { getOverview, getAttention, money } from './api';
import { C, S } from './theme';

export default function HomeScreen({ onRecordDelivery, onOpenSales, onOpenChecks, onFixNumbers, onLogCheck }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [attention, setAttention] = useState(null);

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

  // Fetched separately and allowed to fail quietly. If the attention
  // list is down that is a reason to show no banner, never a reason to
  // stop the bank balance appearing -- the headline figure must not
  // depend on a secondary call.
  React.useEffect(() => {
    let alive = true;
    getAttention()
      .then((r) => { if (alive) setAttention(r); })
      .catch(() => { if (alive) setAttention(null); });
    return () => { alive = false; };
  }, [refreshing]);

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
  const negative = !!data && Number(pos.after_everything) < 0;

  // When the call failed there is no figure, and money(undefined) is "$0".
  // That is how a broken server came to look like an empty bank account:
  // a red line at the top saying the server returned 502, and underneath
  // it, in the biggest type on the screen, $0 in the bank. A number nobody
  // sent must read as no number.
  const fig = (v, cents) => (data && v != null ? money(v, cents) : '—');

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

        {attention && attention.groups && attention.groups.length ? (
          <View style={st.attnBox}>
            <Text style={st.attnTitle}>
              {attention.open} thing{attention.open === 1 ? '' : 's'} need you
            </Text>
            {attention.groups.slice(0, 4).map((g) => (
              <View key={g.code} style={st.attnRow}>
                <View
                  style={[
                    st.attnDot,
                    { backgroundColor: g.severity === 'critical' ? C.red : '#c88a16' },
                  ]}
                />
                <Text style={st.attnLine}>
                  {g.headline}
                  {g.count > 1 ? '  \u00d7' + g.count : ''}
                </Text>
              </View>
            ))}
            <Text style={st.attnFoot}>Open Reconcile on the desktop to deal with these.</Text>
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
            {fig(pos.after_everything)}
          </Text>
          <Text style={st.heroNote}>
            {fig(pos.in_bank)} in the bank · {fig(pos.checks_outstanding)} in checks not cashed
          </Text>
          {/* A bank balance does not say how old it is, and a six-week-old
              one looks exactly like this morning's. Every figure above is
              built on it. */}
          {pos.balance_age_days !== null && pos.balance_age_days !== undefined
            && pos.balance_age_days > 0 ? (
            <Text style={st.staleBank}>
              Bank figure is {pos.balance_age_days === 1 ? 'a day' : pos.balance_age_days + ' days'} old
              {pos.balance_as_of ? ' — ' + pos.balance_as_of : ''}
            </Text>
          ) : null}
          {/* Right under the number it corrects. Buried in a settings screen
              it may as well not exist -- and when the drawer disagrees with
              the app, the moment to say so is while the cash is still in
              hand. */}
          <TouchableOpacity
            style={st.fix}
            onPress={onFixNumbers}
            hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }}
          >
            <Text style={st.fixText}>Wrong? Fix it</Text>
          </TouchableOpacity>
        </View>

        <View style={st.pair}>
          <View style={[S.card, st.half]}>
            <Text style={S.label}>Income this week</Text>
            <Text style={[st.pairValue, { color: C.green }]}>{fig(tot.income)}</Text>
          </View>
          <View style={[S.card, st.half, { marginLeft: 10 }]}>
            <Text style={S.label}>Expense this week</Text>
            <Text style={[st.pairValue, { color: C.red }]}>{fig(tot.expense)}</Text>
          </View>
        </View>

        <TouchableOpacity style={S.big} onPress={onRecordDelivery} activeOpacity={0.85}>
          <Text style={S.bigText}>Record a delivery</Text>
        </TouchableOpacity>

        <TouchableOpacity style={st.secondary} onPress={onLogCheck} activeOpacity={0.8}>
          <Text style={st.secondaryText}>Log a check</Text>
        </TouchableOpacity>

        <TouchableOpacity style={st.secondary} onPress={onOpenSales} activeOpacity={0.8}>
          <Text style={st.secondaryText}>Sales by tender, department and cashier</Text>
        </TouchableOpacity>

        <View style={{ height: 11 }} />

        <View style={S.card}>
          <Text style={S.label}>Needs you</Text>
          {alerts.length === 0 ? (
            <Text style={data ? st.ok : st.unknown}>
              {data ? 'Nothing needs you right now.' : 'Could not load this.'}
            </Text>
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
            <Text style={st.rowHeadAmt}>{fig(pos.ap_open)}</Text>
          </View>
          {vendors.length === 0 ? (
            <Text style={data ? st.ok : st.unknown}>
              {data ? 'You do not owe any vendor right now.' : 'Could not load this.'}
            </Text>
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
            <Text style={st.rowHeadAmt}>{fig(pos.checks_outstanding)}</Text>
          </View>
          {checks.length === 0 ? (
            <Text style={data ? st.ok : st.unknown}>
              {data ? 'Every check you wrote has cleared.' : 'Could not load this.'}
            </Text>
          ) : (
            checks.slice(0, 5).map((c, i) => (
              <View key={i} style={st.row}>
                <View style={{ flex: 1 }}>
                  <Text style={st.rowName}>
                    #{c.check_number || '?'} {c.payee}
                  </Text>
                  <Text style={st.rowSub}>
                    Written {c.payment_date}
                    {c.days_out === null || c.days_out === undefined
                      ? ''
                      : c.days_out <= 0
                      ? ' · today'
                      : c.days_out === 1
                      ? ' · 1 day ago'
                      : ` · ${c.days_out} days ago`}
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

  staleBank: {
    color: '#f0b429', fontSize: 11.5, fontWeight: '700',
    marginTop: 7, textAlign: 'center',
  },

  fix: {
    marginTop: 11, borderWidth: 1, borderColor: '#4a5568',
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7,
  },
  fixText: { color: '#cfd6e2', fontSize: 12.5, fontWeight: '700' },

  secondary: {
    marginTop: 9, borderRadius: 12, paddingVertical: 14, alignItems: 'center',
    backgroundColor: C.white, borderWidth: 1, borderColor: C.blue,
  },
  secondaryText: { color: C.blue, fontSize: 14.5, fontWeight: '700' },

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

  // Deliberately plainer than the error box. These are real and they
  // need him, but they are not the app failing, and a screen where
  // everything shouts is a screen where nothing is heard.
  attnBox: {
    backgroundColor: C.white, borderWidth: 1, borderColor: '#e8d5b0',
    borderLeftWidth: 4, borderLeftColor: '#c88a16',
    borderRadius: 10, padding: 12, marginBottom: 11,
  },
  attnTitle: { fontSize: 13.5, fontWeight: '800', color: C.ink, marginBottom: 8 },
  attnRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  attnDot: { width: 7, height: 7, borderRadius: 4, marginRight: 9 },
  attnLine: { flex: 1, fontSize: 12.5, color: C.ink, lineHeight: 17 },
  attnFoot: { fontSize: 11, color: C.mute, marginTop: 4, lineHeight: 15 },
  // Not green. Green says all is well, and all being well is exactly
  // what a failed call cannot tell him.
  unknown: { fontSize: 13.5, color: C.mute, fontStyle: 'italic' },
  errorBox: { backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca', borderRadius: 10, padding: 11, marginBottom: 11 },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
  errorHint: { fontSize: 11.5, color: C.mute, marginTop: 3 },
});
