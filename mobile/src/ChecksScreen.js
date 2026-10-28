// Every check written and not yet cashed, oldest first -- because the old
// ones are the ones worth asking about.
//
// The number at the top is what is really left: the bank balance less every
// check still out there. The bank's own figure counts money that is already
// spoken for.

import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, ActivityIndicator,
  TouchableOpacity, SafeAreaView, StyleSheet,
} from 'react-native';
import { getChecks, money } from './api';
import { C, S } from './theme';

function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr + 'T12:00:00Z').getTime();
  if (!isFinite(then)) return null;
  const now = new Date().getTime();
  return Math.max(0, Math.round((now - then) / 86400000));
}

export default function ChecksScreen({ onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (isRefresh) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      setData(await getChecks());
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
        <Text style={st.loadingText}>Loading your checks</Text>
      </SafeAreaView>
    );
  }

  const all = (data && data.checks) || [];
  const out = all
    .filter((c) => c.status === 'outstanding')
    .sort((a, b) => String(a.payment_date || '').localeCompare(String(b.payment_date || '')));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={st.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Checks still out</Text>
        <View style={{ width: 52 }} />
      </View>

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

        <View style={st.hero}>
          <Text style={st.heroLabel}>Really left after these clear</Text>
          <Text style={st.heroValue}>{money(data && data.real_available_cash)}</Text>
          <Text style={st.heroNote}>
            {money(data && data.bank_balance)} in the bank ·{' '}
            {money(data && data.outstanding_total)} written and not cashed
          </Text>
        </View>

        <View style={S.card}>
          <Text style={S.label}>
            {out.length} check{out.length === 1 ? '' : 's'} out
          </Text>
          {!out.length ? (
            <Text style={st.ok}>Every check you wrote has cleared.</Text>
          ) : (
            out.map((c) => {
              const age = daysSince(c.payment_date);
              // A month is when a check stops being in the post and starts
              // being a question.
              const stale = age !== null && age > 30;
              return (
                <View key={c.payment_id} style={st.row}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Text style={st.name}>
                      #{c.check_number || '?'} {c.vendor_name || c.memo || 'No payee recorded'}
                    </Text>
                    <Text style={[st.sub, stale && st.subStale]}>
                      Written {c.payment_date}
                      {age === null ? '' : age === 0 ? ' · today' : age === 1 ? ' · 1 day ago' : ` · ${age} days ago`}
                      {stale ? ' · worth chasing' : ''}
                    </Text>
                  </View>
                  <Text style={st.amt}>{money(c.amount)}</Text>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  loadingText: { marginTop: 12, color: C.mute, fontSize: 13 },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  back: { color: C.blue, fontSize: 15, fontWeight: '700', width: 52 },
  barTitle: { fontSize: 15.5, fontWeight: '800', color: C.ink },

  hero: { backgroundColor: C.ink, borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 11 },
  heroLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: '#9aa3b2', textTransform: 'uppercase' },
  heroValue: { fontSize: 38, fontWeight: '800', color: C.white, letterSpacing: -1.6, marginVertical: 5 },
  heroNote: { fontSize: 11.5, color: '#9aa3b2', textAlign: 'center' },

  ok: { fontSize: 13.5, color: C.green, fontWeight: '600', paddingVertical: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#f1f3f7',
  },
  name: { fontSize: 14, fontWeight: '600', color: C.ink },
  sub: { fontSize: 11.5, color: C.mute, marginTop: 2 },
  subStale: { color: C.amber, fontWeight: '700' },
  amt: { fontSize: 14.5, fontWeight: '700', color: C.ink },

  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 11, marginBottom: 11,
  },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
  errorHint: { fontSize: 11.5, color: C.mute, marginTop: 3 },
});
