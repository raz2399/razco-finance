// Money that left without a bill or a bank line.
//
// Cash out of the drawer for ice. The gardener, paid in notes. A payroll
// run. None of it has an invoice to photograph, and the cash ones never
// touch the bank at all -- so until now every one of them was simply
// missing from the profit figure, which made each week look better than
// it was.
//
// Built to be finished in under fifteen seconds standing at the till,
// because anything slower gets done later, and later means never: the
// amount first, because that is the thing he is holding in his head, and
// a row of buttons for how it was paid rather than a dropdown to open.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, SafeAreaView, StyleSheet,
  TextInput, ActivityIndicator, RefreshControl,
} from 'react-native';
import { C, S } from './theme';
import { getSpendSetup, recordSpend, removeSpend } from './api';

function dollars(n) {
  const v = Number(n) || 0;
  return '$' + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export default function SpendScreen({ onBack, onDone }) {
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [categoryId, setCategoryId] = useState(null);
  const [memo, setMemo] = useState('');

  const [said, setSaid] = useState(null);
  const [warn, setWarn] = useState(null);
  const [problem, setProblem] = useState(null);
  const [clash, setClash] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getSpendSetup();
      setSetup(r);
      setProblem(null);
    } catch (e) {
      setProblem(e && e.message ? e.message : 'Could not load.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (anyway) => {
    setBusy(true);
    setSaid(null);
    setWarn(null);
    setProblem(null);
    if (!anyway) setClash(null);
    try {
      const r = await recordSpend({
        amount: Number(String(amount).replace(/[^0-9.]/g, '')),
        method: method,
        category_id: categoryId,
        memo: memo,
        anyway: !!anyway,
      });
      if (r && r.ok) {
        setSaid(r.says);
        setWarn(r.warn || null);
        setAmount('');
        setMemo('');
        setClash(null);
        await load();
        if (onDone) onDone();
      } else {
        setProblem((r && r.error) || 'That did not save.');
      }
    } catch (e) {
      // The bank already has this figure. Worth stopping over: the same
      // money on the books twice is a worse problem than a missing line,
      // because nothing on any screen looks wrong afterwards.
      if (e && e.data && e.data.duplicate_of) {
        setClash({ text: e.message });
      } else {
        setProblem(e && e.message ? e.message : 'Could not reach the server.');
      }
    }
    setBusy(false);
  };

  const drop = async (id) => {
    try {
      await removeSpend(id);
      await load();
      if (onDone) onDone();
    } catch (e) {
      setProblem(e && e.message ? e.message : 'Could not take it off.');
    }
  };

  const cats = (setup && setup.categories) || [];
  const ways = (setup && setup.ways) || [];
  const recent = (setup && setup.recent) || [];
  const ready = Number(String(amount).replace(/[^0-9.]/g, '')) > 0 && categoryId;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.head}>
        <TouchableOpacity onPress={onBack} style={{ paddingVertical: 4, paddingRight: 12 }}>
          <Text style={{ color: C.red, fontSize: 16, fontWeight: '700' }}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.title}>Money out</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 13, paddingBottom: 44 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.red} />}
      >
        <View style={S.card}>
          <Text style={st.lede}>
            Cash from the drawer, payroll, anything with no invoice and no
            bank line of its own.
          </Text>

          <Text style={S.label}>How much</Text>
          <TextInput
            style={st.amount}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor="#c3c9d4"
          />

          <Text style={[S.label, { marginTop: 16 }]}>How it was paid</Text>
          <View style={st.wrap}>
            {ways.map((w) => (
              <TouchableOpacity
                key={w.key}
                onPress={() => setMethod(w.key)}
                style={[st.chip, method === w.key && st.chipOn]}
              >
                <Text style={[st.chipText, method === w.key && { color: C.white }]}>
                  {w.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[S.label, { marginTop: 16 }]}>What for</Text>
          <View style={st.wrap}>
            {cats.map((c) => (
              <TouchableOpacity
                key={c.category_id}
                onPress={() => setCategoryId(c.category_id)}
                style={[st.chip, categoryId === c.category_id && st.chipOn]}
              >
                <Text style={[st.chipText, categoryId === c.category_id && { color: C.white }]}>
                  {c.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[S.label, { marginTop: 16 }]}>Note (optional)</Text>
          <TextInput
            style={st.memo}
            value={memo}
            onChangeText={setMemo}
            placeholder="Who or what it was for"
            placeholderTextColor="#9aa3af"
          />

          <TouchableOpacity
            style={[S.big, { marginTop: 16 }, (!ready || busy) && { opacity: 0.45 }]}
            onPress={() => save(false)}
            disabled={!ready || busy}
          >
            <Text style={S.bigText}>{busy ? 'Saving…' : 'Write it down'}</Text>
          </TouchableOpacity>

          {said ? <Text style={st.said}>{said}</Text> : null}
          {warn ? <Text style={st.warn}>{warn}</Text> : null}
          {problem ? <Text style={st.problem}>{problem}</Text> : null}

          {clash ? (
            <View style={st.clash}>
              <Text style={st.clashText}>{clash.text}</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <TouchableOpacity
                  style={[S.big, { flex: 1, backgroundColor: C.white, borderWidth: 1, borderColor: C.line }]}
                  onPress={() => setClash(null)}
                >
                  <Text style={[S.bigText, { color: C.ink }]}>Leave it</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[S.big, { flex: 1 }]}
                  onPress={() => save(true)}
                >
                  <Text style={S.bigText}>Different money</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </View>

        {loading && !setup ? <ActivityIndicator color={C.red} style={{ marginTop: 20 }} /> : null}

        {recent.length ? (
          <View style={S.card}>
            <Text style={S.label}>Lately</Text>
            {recent.map((r) => (
              <View key={r.payment_id} style={st.row}>
                <Text style={st.rowDate}>{String(r.date || '').slice(5)}</Text>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={st.rowWhat} numberOfLines={1}>
                    {r.category || 'Uncategorised'}
                  </Text>
                  {r.memo && r.memo !== r.category ? (
                    <Text style={st.rowMemo} numberOfLines={1}>{r.memo}</Text>
                  ) : null}
                </View>
                <Text style={st.rowAmt}>{dollars(r.amount)}</Text>
                <TouchableOpacity onPress={() => drop(r.payment_id)} style={{ paddingLeft: 10 }}>
                  <Text style={{ color: C.red, fontSize: 13, fontWeight: '700' }}>Undo</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13,
    paddingTop: 6, paddingBottom: 10, backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title: { fontSize: 19, fontWeight: '800', color: C.ink },
  lede: { fontSize: 13, lineHeight: 19, color: C.mute, marginBottom: 16 },
  amount: {
    fontSize: 34, fontWeight: '800', color: C.ink, paddingVertical: 6,
    borderBottomWidth: 2, borderBottomColor: C.line,
    fontVariant: ['tabular-nums'],
  },
  memo: {
    fontSize: 15, color: C.ink, paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: 1, borderColor: C.line, borderRadius: 10, marginTop: 4,
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  chip: {
    borderWidth: 1, borderColor: C.line, borderRadius: 9,
    paddingVertical: 9, paddingHorizontal: 13, backgroundColor: C.white,
  },
  chipOn: { backgroundColor: C.ink, borderColor: C.ink },
  chipText: { fontSize: 13, fontWeight: '700', color: C.mute },
  said: { marginTop: 13, fontSize: 13.5, lineHeight: 19, color: C.green, fontWeight: '700' },
  warn: { marginTop: 8, fontSize: 12.5, lineHeight: 18, color: C.amber },
  problem: { marginTop: 13, fontSize: 13, lineHeight: 19, color: C.red, fontWeight: '600' },
  clash: {
    marginTop: 14, padding: 13, borderRadius: 11,
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3d3d3',
  },
  clashText: { fontSize: 13, lineHeight: 19, color: '#8d2024', fontWeight: '600' },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: '#f1f3f7',
  },
  rowDate: { width: 44, fontSize: 12, color: C.mute, fontVariant: ['tabular-nums'] },
  rowWhat: { fontSize: 13.5, fontWeight: '700', color: C.ink },
  rowMemo: { fontSize: 11.5, color: C.mute, marginTop: 1 },
  rowAmt: { fontSize: 13.5, fontWeight: '800', color: C.ink, fontVariant: ['tabular-nums'] },
});
