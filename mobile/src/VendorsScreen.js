// Who Razco buys from, and on what terms.
//
// 255 of them, so the search box does the work. The ones whose payment type
// was never recorded are gathered at the top rather than buried: until that
// is answered, an invoice from one of them cannot be given a due date, and
// a due date nobody chose is worse than no due date at all.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, RefreshControl, ActivityIndicator,
  TouchableOpacity, SafeAreaView, StyleSheet,
} from 'react-native';
import { getVendorList } from './api';
import { C, S } from './theme';

const METHOD = {
  cod: { label: 'COD', note: 'check at the door' },
  cod_draft: { label: 'COD draft', note: 'bank takes it next day' },
  auto_debit: { label: 'Auto-draft', note: 'bank takes it on the due date' },
  charge_account: { label: 'Charge', note: 'we write a check on terms' },
  check: { label: 'Check', note: 'we write a check on terms' },
};

export default function VendorsScreen({ onBack }) {
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async (isRefresh) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const r = await getVendorList();
      setAll((r && r.vendor_list) || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const { unset, known } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (v) => {
      if (!needle) return true;
      if (String(v.vendor_name || '').toLowerCase().indexOf(needle) > -1) return true;
      return (v.aliases || []).some((a) => String(a).toLowerCase().indexOf(needle) > -1);
    };
    const hits = all.filter(match);
    return {
      unset: hits.filter((v) => !v.pay_method),
      known: hits.filter((v) => v.pay_method),
    };
  }, [all, q]);

  if (loading) {
    return (
      <SafeAreaView style={st.center}>
        <ActivityIndicator size="large" color={C.red} />
        <Text style={st.loadingText}>Loading your vendors</Text>
      </SafeAreaView>
    );
  }

  const Row = ({ v }) => {
    const m = METHOD[v.pay_method];
    return (
      <View style={st.row}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={st.name} numberOfLines={1}>{v.vendor_name}</Text>
          <Text style={st.sub}>
            {m ? m.label + ' — ' + m.note : 'Payment type never recorded'}
            {v.terms ? '  ·  ' + v.terms : ''}
          </Text>
          {v.aliases && v.aliases.length ? (
            <Text style={st.alias} numberOfLines={1}>also {v.aliases.join(', ')}</Text>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={st.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Vendors</Text>
        <View style={{ width: 52 }} />
      </View>

      <View style={st.searchWrap}>
        <TextInput
          style={st.search}
          value={q}
          onChangeText={setQ}
          placeholder={'Search ' + all.length + ' vendors'}
          placeholderTextColor="#b6bcc8"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.red} />
        }
      >
        {error ? (
          <View style={st.errorBox}><Text style={st.errorText}>{error}</Text></View>
        ) : null}

        {unset.length ? (
          <View style={S.card}>
            <Text style={S.label}>Needs a payment type ({unset.length})</Text>
            <Text style={st.explain}>
              These came from QuickBooks with no terms. Record an invoice from one and
              the app will ask you how they get paid.
            </Text>
            {unset.map((v) => <Row key={v.vendor_id} v={v} />)}
          </View>
        ) : null}

        {known.length ? (
          <View style={S.card}>
            <Text style={S.label}>Set up ({known.length})</Text>
            {known.map((v) => <Row key={v.vendor_id} v={v} />)}
          </View>
        ) : null}

        {!unset.length && !known.length ? (
          <View style={S.card}>
            <Text style={st.none}>
              {q.trim() ? 'No vendor matches “' + q.trim() + '”.' : 'No vendors on file yet.'}
            </Text>
          </View>
        ) : null}
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

  searchWrap: {
    paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  search: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.ink,
    backgroundColor: C.bg,
  },

  explain: { fontSize: 11.5, color: C.mute, lineHeight: 16, marginTop: 4, marginBottom: 2 },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f3f7' },
  name: { fontSize: 14, fontWeight: '600', color: C.ink },
  sub: { fontSize: 11.5, color: C.mute, marginTop: 2 },
  alias: { fontSize: 10.5, color: '#9aa3b2', marginTop: 1, fontStyle: 'italic' },
  none: { fontSize: 13, color: C.mute, paddingVertical: 8 },

  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 11, marginBottom: 11,
  },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
});
