// The statement, with a highlighter run down it.
//
// The marking is the same on this screen as on the dashboard because it
// is decided in one place on the server. If the phone worked out which
// lines were cleared for itself, the two would eventually disagree, and
// a disagreement here looks like money appearing or vanishing.
//
//   yellow            dealt with
//   yellow + red edge cleared, and still wants him
//   plain             still pending at the bank
//
// Pending is deliberately unmarked. A mark says the reconciling is
// finished with that line, and the bank can still take a pending line
// back.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, SafeAreaView, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { C, S } from './theme';
import { getStatement, applyStatement } from './api';

const MARK = 'rgba(255,214,51,0.42)';
const EDGE = '#e8b400';
const NEEDS = '#a8301f';

const RANGES = [
  { days: 21, name: '3 weeks' },
  { days: 45, name: '6 weeks' },
  { days: 90, name: '3 months' },
];

function dollars(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-$' : '$') + s;
}

function dayOf(iso) {
  const s = String(iso || '');
  return s.length >= 10 ? s.slice(5, 10) : s;
}

export default function StatementScreen({ onBack, onDone }) {
  const [days, setDays] = useState(21);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [problem, setProblem] = useState(null);

  const load = useCallback(async (d) => {
    setLoading(true);
    setProblem(null);
    try {
      const res = await getStatement(d);
      setData(res && res.ok ? res : null);
      if (!(res && res.ok)) setProblem('Could not read the statement just now.');
    } catch (e) {
      setProblem(e && e.message ? e.message : 'Could not reach the server.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const doAll = async () => {
    setBusy(true);
    setSaid(null);
    setProblem(null);
    try {
      const res = await applyStatement(days);
      if (res && res.ok) {
        const left = (res.did && res.did.problems) || [];
        setSaid(res.says + (left.length
          ? ' ' + left.length + ' could not be done and were left alone.'
          : ''));
        await load(days);
        if (onDone) onDone();
      } else {
        setProblem((res && res.error) || 'That did not go through. Nothing was changed.');
      }
    } catch (e) {
      setProblem(e && e.message ? e.message : 'Could not reach the server.');
    }
    setBusy(false);
  };

  const counts = (data && data.counts) || {};
  const rows = (data && data.rows) || [];
  const ready = Number(counts.can_name) || 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.head}>
        <TouchableOpacity onPress={onBack} style={{ paddingVertical: 4, paddingRight: 12 }}>
          <Text style={{ color: C.red, fontSize: 16, fontWeight: '700' }}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.title}>Your statement</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 13, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => load(days)} tintColor={C.red} />
        }
      >
        <View style={S.card}>
          <Text style={st.lede}>
            Every line the bank has. <Text style={{ fontWeight: '800' }}>Yellow has been
            dealt with.</Text> A red edge means it cleared but still wants something from
            you. Plain lines are still pending at the bank.
          </Text>

          <TouchableOpacity
            style={[S.big, busy && { opacity: 0.6 }]}
            onPress={doAll}
            disabled={busy}
          >
            <Text style={S.bigText}>
              {busy ? 'Working…' : (ready ? 'Do all of it (' + ready + ' ready)' : 'Do all of it')}
            </Text>
          </TouchableOpacity>

          <View style={st.ranges}>
            {RANGES.map((r) => (
              <TouchableOpacity
                key={r.days}
                onPress={() => setDays(r.days)}
                style={[st.range, days === r.days && st.rangeOn]}
              >
                <Text style={[st.rangeText, days === r.days && { color: C.white }]}>
                  {r.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {said ? <Text style={st.said}>{said}</Text> : null}
          {problem ? <Text style={st.problem}>{problem}</Text> : null}
        </View>

        {data ? (
          <View style={S.card}>
            <Text style={S.label}>Where it stands</Text>
            <View style={{ marginTop: 10 }}>
              <Key swatch={{ backgroundColor: MARK, borderLeftColor: EDGE }}
                text={(counts.settled || 0) + ' dealt with'} />
              <Key swatch={{ backgroundColor: MARK, borderLeftColor: NEEDS }}
                text={(counts.needs || 0) + ' want you'} />
              <Key swatch={{ backgroundColor: C.white, borderLeftColor: C.line }}
                text={(counts.pending || 0) + ' still pending'} />
              <Key swatch={{ backgroundColor: C.white, borderLeftColor: C.green }}
                text={(counts['in'] || 0) + ' money in'} />
            </View>
          </View>
        ) : null}

        {loading && !rows.length ? (
          <ActivityIndicator color={C.red} style={{ marginTop: 24 }} />
        ) : null}

        {!loading && !rows.length && !problem ? (
          <Text style={st.empty}>No bank activity in this stretch.</Text>
        ) : null}

        {rows.length ? (
          <View style={[S.card, { padding: 0, overflow: 'hidden' }]}>
            {rows.map((r, i) => <Line key={r.bank_txn_id || i} r={r} first={i === 0} />)}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Key({ swatch, text }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 7 }}>
      <View style={[st.chip, swatch]} />
      <Text style={{ fontSize: 13, color: C.mute }}>{text}</Text>
    </View>
  );
}

function Line({ r, first }) {
  const marked = r.state === 'settled' || r.state === 'needs';
  const edge = r.state === 'needs' ? NEEDS : (marked ? EDGE : 'transparent');

  let what = r.vendor || r.description || 'Bank line';
  if (r.check_number) what = 'Check ' + r.check_number + ' · ' + what;

  let tag = null;
  if (r.state === 'pending') tag = { text: 'pending', red: false };
  else if (r.needs === 'name') tag = { text: 'whose?', red: true };
  else if (r.needs === 'not_in_books') tag = { text: 'unknown', red: true };
  else if (r.is_cost) tag = { text: 'cost', red: false };

  let note = null;
  if (r.suggest) {
    note = 'Looks like ' + (r.suggest.vendor || 'a vendor')
      + (r.suggest.invoice_number ? ', invoice ' + r.suggest.invoice_number : '')
      + ' — same amount, only one bill open for it.';
  } else if (r.needs === 'not_in_books') {
    note = 'The bank took this and the books have never heard of it.';
  }

  return (
    <View style={[
      st.line,
      !first && { borderTopWidth: 1, borderTopColor: '#f1f3f7' },
      marked && { backgroundColor: MARK },
      { borderLeftWidth: 3, borderLeftColor: edge },
      r.state === 'pending' && { opacity: 0.72 },
    ]}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={st.date}>{dayOf(r.date)}</Text>
        <Text style={st.what} numberOfLines={1}>{what}</Text>
        <Text style={[st.amt, r.amount > 0 && { color: C.green }]}>{dollars(r.amount)}</Text>
      </View>
      {tag || note ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 5, paddingLeft: 52 }}>
          {tag ? (
            <Text style={[st.tag, tag.red && { backgroundColor: '#f7dedb', color: '#8d2024' }]}>
              {tag.text}
            </Text>
          ) : null}
          {note ? <Text style={st.note} numberOfLines={2}>{note}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13,
    paddingTop: 6, paddingBottom: 10, backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title: { fontSize: 19, fontWeight: '800', color: C.ink },
  lede: { fontSize: 13, lineHeight: 19, color: C.mute, marginBottom: 14 },
  ranges: { flexDirection: 'row', marginTop: 12 },
  range: {
    borderWidth: 1, borderColor: C.line, borderRadius: 9,
    paddingVertical: 8, paddingHorizontal: 13, marginRight: 8,
  },
  rangeOn: { backgroundColor: C.ink, borderColor: C.ink },
  rangeText: { fontSize: 13, fontWeight: '700', color: C.mute },
  said: { marginTop: 13, fontSize: 13, lineHeight: 19, color: C.ink },
  problem: { marginTop: 13, fontSize: 13, lineHeight: 19, color: C.red, fontWeight: '600' },
  empty: { textAlign: 'center', color: C.mute, fontSize: 13, marginTop: 24 },
  chip: { width: 22, height: 14, borderRadius: 3, borderLeftWidth: 3, marginRight: 9 },
  line: { paddingVertical: 10, paddingHorizontal: 12 },
  date: { width: 46, fontSize: 12.5, color: '#5b6472', fontVariant: ['tabular-nums'] },
  what: { flex: 1, fontSize: 13.5, fontWeight: '700', color: C.ink, paddingRight: 8 },
  amt: { fontSize: 13.5, fontWeight: '800', color: C.ink, fontVariant: ['tabular-nums'] },
  tag: {
    fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase',
    backgroundColor: '#eef1f5', color: '#5b6472',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, marginRight: 8,
    overflow: 'hidden',
  },
  note: { flex: 1, fontSize: 11.5, lineHeight: 16, color: '#6b7483' },
});
