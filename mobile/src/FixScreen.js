// When the system is wrong, this is where Raz makes it right -- from the
// floor, with the drawer open in front of him, rather than from the desktop
// later when the count is a memory.
//
// Two figures can be corrected: what is in the bank, and how much cash is
// actually on hand. A number a person counted beats a number a computer
// inferred, so the counted figure replaces the computed one outright. It is
// not averaged and not argued with.
//
// Every change is written down with a reason and shown back on this screen.
// A figure that can be changed without a trace is a figure nobody can trust
// later, including the person who changed it.

import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
  RefreshControl, SafeAreaView, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { getCorrections, correctFigure, money } from './api';
import { C, S } from './theme';

const TARGETS = [
  {
    key: 'bank',
    title: 'In the bank',
    asks: 'What does the bank actually say?',
    hint: 'Use the balance on the bank’s own screen, not the available figure.',
  },
  {
    key: 'cash',
    title: 'Cash on hand',
    asks: 'What did you count?',
    hint: 'Drawers and safe together, as counted just now.',
  },
];

export default function FixScreen({ onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [target, setTarget] = useState(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(async (isRefresh) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      setData(await getCorrections());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // The figure is only readable when it parses. Letting a fumbled keystroke
  // through would zero the number it was meant to correct.
  const parsed = (function () {
    const cleaned = String(amount).replace(/[$,\s]/g, '');
    if (!cleaned) return null;
    if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return isFinite(n) ? Math.round(n * 100) / 100 : null;
  }());

  const current = data && target ? data[target] : null;
  const difference = current && parsed !== null ? Math.round((parsed - current.amount) * 100) / 100 : null;

  async function save() {
    if (parsed === null || !target) return;
    setSaving(true);
    try {
      const res = await correctFigure(target, parsed, note.trim());
      setDone({
        target,
        was: res.was,
        now: res.now,
      });
      setTarget(null); setAmount(''); setNote('');
      await load(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={st.center}>
        <ActivityIndicator size="large" color={C.red} />
        <Text style={st.loadingText}>Reading what the system believes</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={st.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Fix a number</Text>
        <View style={{ width: 52 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={8}
      >
        <ScrollView
          contentContainerStyle={{ padding: 12, paddingBottom: 60 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.red} />
          }
        >
          {error ? (
            <View style={st.errorBox}><Text style={st.errorText}>{error}</Text></View>
          ) : null}

          {done ? (
            <View style={st.okBox}>
              <Text style={st.okText}>
                {done.target === 'bank' ? 'Bank balance' : 'Cash on hand'} is now {money(done.now)}
                {done.was === null || done.was === undefined ? '' : `, was ${money(done.was)}`}.
              </Text>
            </View>
          ) : null}

          <Text style={st.intro}>
            What the system believes right now. If a figure is wrong, tap it and put in
            the real one.
          </Text>

          {TARGETS.map((t) => {
            const cur = data ? data[t.key] : null;
            const open = target === t.key;
            return (
              <View key={t.key} style={S.card}>
                <TouchableOpacity
                  onPress={() => {
                    setDone(null);
                    setTarget(open ? null : t.key);
                    setAmount(''); setNote('');
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={S.label}>{t.title}</Text>
                  <Text style={st.figure}>
                    {cur ? money(cur.amount) : 'Never set'}
                  </Text>
                  <Text style={st.asOf}>
                    {cur && cur.as_of
                      ? (t.key === 'bank' ? 'As of ' : 'Counted ') + cur.as_of
                      : t.key === 'cash'
                      ? 'No one has counted the drawer yet'
                      : 'No statement has been loaded'}
                    {!open ? '   ·   tap to correct' : ''}
                  </Text>
                </TouchableOpacity>

                {open ? (
                  <View style={st.form}>
                    <Text style={st.asks}>{t.asks}</Text>
                    <TextInput
                      style={[st.input, st.money]}
                      value={amount}
                      onChangeText={(v) => { setAmount(v); setDone(null); }}
                      placeholder="0.00"
                      placeholderTextColor="#b6bcc8"
                      keyboardType="decimal-pad"
                      autoFocus
                    />
                    <Text style={st.hint}>{t.hint}</Text>

                    {difference !== null && difference !== 0 ? (
                      <Text style={[st.diff, difference < 0 ? st.diffDown : st.diffUp]}>
                        {difference > 0 ? 'Up ' : 'Down '}
                        {money(Math.abs(difference))} from what the system has.
                      </Text>
                    ) : null}
                    {amount.trim() && parsed === null ? (
                      <Text style={st.bad}>That is not a number I can read.</Text>
                    ) : null}

                    <Text style={[S.label, { marginTop: 14 }]}>Why</Text>
                    <TextInput
                      style={st.input}
                      value={note}
                      onChangeText={setNote}
                      placeholder="Counted the safe, we were off"
                      placeholderTextColor="#b6bcc8"
                    />
                    <Text style={st.hint}>
                      Written down with the change. In three months this is the only thing
                      that explains the number.
                    </Text>

                    <TouchableOpacity
                      style={[S.big, { marginTop: 14 }, (parsed === null || saving) && st.disabled]}
                      onPress={save}
                      disabled={parsed === null || saving}
                      activeOpacity={0.85}
                    >
                      <Text style={S.bigText}>
                        {saving ? 'Saving…' : 'Use my number'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            );
          })}

          <View style={S.card}>
            <Text style={S.label}>Corrections made</Text>
            {!data || !data.corrections || !data.corrections.length ? (
              <Text style={st.none}>Nothing has been corrected yet.</Text>
            ) : (
              data.corrections.map((c, i) => (
                <View key={i} style={st.logRow}>
                  <Text style={st.logWhat}>{c.what}</Text>
                  <Text style={st.logWhy}>
                    {c.why}
                    {c.at ? '  ·  ' + String(c.at).slice(0, 10) : ''}
                  </Text>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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

  intro: { fontSize: 12.5, color: C.mute, lineHeight: 18, marginBottom: 11, paddingHorizontal: 2 },

  figure: { fontSize: 30, fontWeight: '800', color: C.ink, letterSpacing: -1.1, marginTop: 3 },
  asOf: { fontSize: 11.5, color: C.mute, marginTop: 2 },

  form: { marginTop: 14, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14 },
  asks: { fontSize: 13.5, fontWeight: '700', color: C.ink, marginBottom: 7 },
  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, color: C.ink,
    backgroundColor: C.white,
  },
  money: { fontSize: 24, fontWeight: '800', letterSpacing: -0.6 },
  hint: { fontSize: 11, color: C.mute, marginTop: 5, lineHeight: 16 },
  diff: { fontSize: 12.5, fontWeight: '700', marginTop: 8 },
  diffUp: { color: C.green },
  diffDown: { color: C.red },
  bad: { fontSize: 12, color: C.red, fontWeight: '700', marginTop: 8 },
  disabled: { opacity: 0.4 },

  none: { fontSize: 13, color: C.mute, paddingVertical: 8 },
  logRow: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#f1f3f7' },
  logWhat: { fontSize: 13, color: C.ink, fontWeight: '600', lineHeight: 18 },
  logWhy: { fontSize: 11, color: C.mute, marginTop: 2 },

  okBox: {
    backgroundColor: '#e9f6ef', borderWidth: 1, borderColor: '#bfe3d0',
    borderRadius: 10, padding: 11, marginBottom: 11,
  },
  okText: { fontSize: 13, color: C.green, fontWeight: '700', lineHeight: 18 },
  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 11, marginBottom: 11,
  },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
});
