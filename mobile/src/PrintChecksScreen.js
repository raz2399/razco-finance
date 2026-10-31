// Printing checks, from the phone.
//
// ---------------------------------------------------------------------
// What the phone can and cannot do
//
// It cannot print. There is no printer in a phone and no print library
// in this app -- adding one would mean a new binary through TestFlight
// before Raz could print anything at all, which is the opposite of
// useful tonight.
//
// What it CAN do is the part that actually needs judgement: who gets
// paid, how much, and which numbers those checks carry. Then it hands
// Safari a link to the printable page, and Safari's share sheet has
// Print on it. Every iPhone, nothing installed.
//
// ---------------------------------------------------------------------
// The number is the dangerous part
//
// A check number is a serial number on paper that has already come out
// of a printer. So nothing is numbered until the last button: back out
// before then and nothing is spent. The server refuses the whole run if
// any number in the range has ever been used -- including a voided one,
// because that paper exists and is ruined.

import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, SafeAreaView, StyleSheet, RefreshControl, Linking,
} from 'react-native';
import { checksToPrint, printChecks, siteRoot, money } from './api';
import { C, S } from './theme';

export default function PrintChecksScreen({ onBack, onDone }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [picked, setPicked] = useState({});
  const [start, setStart] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(async (isRefresh) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const r = await checksToPrint();
      setData(r);
      // Everything printable starts ticked: the common case is paying
      // the whole list, and unticking two is less work than ticking six.
      const on = {};
      ((r && r.waiting) || []).forEach((w) => { if (w.printable) on[w.payment_id] = true; });
      setPicked(on);
      if (r && r.suggested_next) setStart(String(r.suggested_next));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const waiting = (data && data.waiting) || [];
  const chosen = waiting.filter((w) => picked[w.payment_id]);
  const total = chosen.reduce((s, w) => s + (Number(w.amount) || 0), 0);
  const books = (data && data.books) || [];
  const lowBook = ((data && data.nearly_out) || [])[0];

  const startNum = parseInt(String(start).replace(/[^0-9]/g, ''), 10);
  const lastNum = startNum && chosen.length ? startNum + chosen.length - 1 : null;

  async function go() {
    if (!chosen.length) { setError('Tick the checks to print first.'); return; }
    if (!startNum) { setError('Put in the number of the first check in the printer.'); return; }

    setBusy(true);
    setError(null);
    try {
      const r = await printChecks(chosen.map((c) => c.payment_id), startNum);
      setDone(r);
      if (onDone) onDone();
    } catch (e) {
      // The server refuses the whole run on a clash rather than printing
      // some of it, so this is the real message and worth showing whole.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function openSheet() {
    if (!done || !done.sheet_url) return;
    const url = siteRoot() + done.sheet_url;
    try {
      await Linking.openURL(url);
    } catch (e) {
      setError('Could not open the print page. ' + e.message);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={st.center}>
        <ActivityIndicator size="large" color={C.red} />
        <Text style={st.loading}>Looking for checks to print</Text>
      </SafeAreaView>
    );
  }

  // ---- after the numbers have been handed out ------------------------
  if (done) {
    const printed = done.printed || [];
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={st.bar}>
          <View style={{ width: 56 }} />
          <Text style={st.barTitle}>Numbered</Text>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={st.back}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
          <Text style={st.doneTitle}>
            {printed.length} check{printed.length === 1 ? '' : 's'}
            {printed.length
              ? ', ' + printed[0].check_number
                + (printed.length > 1 ? ' to ' + printed[printed.length - 1].check_number : '')
              : ''}
          </Text>
          <Text style={st.doneSub}>
            Marked outstanding. They clear themselves off when the bank takes them.
          </Text>

          <TouchableOpacity style={[S.big, { marginBottom: 10 }]} onPress={openSheet} activeOpacity={0.85}>
            <Text style={S.bigText}>Open the printable page</Text>
          </TouchableOpacity>
          <Text style={st.hint}>
            It opens in Safari. Tap Share, then Print. Turn off &ldquo;fit to
            page&rdquo; &mdash; it has to print at 100% or nothing lands where it
            should. The link lasts ten minutes; the numbers are already saved.
          </Text>

          <View style={st.card}>
            {printed.map((p, i) => (
              <View
                key={p.payment_id}
                style={[st.row, i === printed.length - 1 && { borderBottomWidth: 0 }]}
              >
                <Text style={st.num}>#{p.check_number}</Text>
                <Text style={st.payee} numberOfLines={1}>{p.payee}</Text>
                <Text style={st.amount}>{money(p.amount)}</Text>
              </View>
            ))}
          </View>

          <Text style={st.hint}>
            Check the paper before you sign. If one came out wrong, void it &mdash;
            the number stays spent, because that check exists.
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- choosing ------------------------------------------------------
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={st.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Print checks</Text>
        <View style={{ width: 56 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 30 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.red} />
        }
      >
        {error ? (
          <View style={st.errorBox}><Text style={st.errorText}>{error}</Text></View>
        ) : null}

        {!waiting.length ? (
          <Text style={st.empty}>
            No checks are waiting to be printed. A check logged here with no number
            yet shows up in this list.
          </Text>
        ) : (
          <View>
            <Text style={st.hint}>
              Tick who gets paid. Nothing is numbered until you press print.
            </Text>

            <View style={st.card}>
              {waiting.map((w, i) => {
                const on = !!picked[w.payment_id];
                return (
                  <TouchableOpacity
                    key={w.payment_id}
                    style={[st.row, i === waiting.length - 1 && { borderBottomWidth: 0 },
                      !w.printable && { opacity: 0.45 }]}
                    onPress={() => {
                      if (!w.printable) return;
                      const next = Object.assign({}, picked);
                      next[w.payment_id] = !on;
                      setPicked(next);
                      setError(null);
                    }}
                    disabled={!w.printable}
                    activeOpacity={0.6}
                  >
                    <View style={[st.tick, on && st.tickOn]}>
                      {on ? <Text style={st.tickMark}>✓</Text> : null}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={st.payee} numberOfLines={1}>{w.payee}</Text>
                      <Text style={st.sub} numberOfLines={1}>
                        {w.printable
                          ? w.payment_date + (w.memo ? ' · ' + w.memo : '')
                          : 'The amount cannot be written on a check'}
                      </Text>
                    </View>
                    <Text style={st.amount}>{money(w.amount)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[S.label, { marginTop: 20 }]}>First check in the printer</Text>
            <TextInput
              style={st.number}
              value={start}
              onChangeText={(v) => { setStart(v); setError(null); }}
              keyboardType="number-pad"
              placeholder="9926"
              placeholderTextColor="#b6bcc8"
            />
            {lastNum && chosen.length > 1 ? (
              <Text style={st.hint}>
                {chosen.length} checks: {startNum} to {lastNum}.
              </Text>
            ) : null}

            {books.length ? (
              <View style={st.card}>
                <Text style={st.cardHead}>Your checkbooks</Text>
                {books.slice(0, 3).map((b) => (
                  <View key={b.series} style={st.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={st.payee}>{b.series}s</Text>
                      <Text style={st.sub}>Last used {b.highest} on {b.last_used || '?'}</Text>
                    </View>
                    <Text style={[st.left, b.left_in_book <= 25 && st.leftLow]}>
                      {b.left_in_book} left
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {lowBook ? (
              <View style={st.warnBox}>
                <Text style={st.warnText}>
                  The {lowBook.series} book runs out at {lowBook.series + 999}. Only{' '}
                  {lowBook.left_in_book} left — order more.
                </Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[S.big, { marginTop: 18 }, busy && { opacity: 0.5 }]}
              onPress={go}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy
                ? <ActivityIndicator color={C.white} />
                : (
                  <Text style={S.bigText}>
                    Number {chosen.length} check{chosen.length === 1 ? '' : 's'} and print
                  </Text>
                )}
            </TouchableOpacity>

            <Text style={st.foot}>
              {money(total, true)} in all. A number that has ever been used before
              stops the whole run rather than printing some of it.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  loading: { marginTop: 12, fontSize: 13.5, color: C.mute },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  back: { color: C.blue, fontSize: 15, fontWeight: '700', width: 56 },
  barTitle: { flex: 1, textAlign: 'center', fontSize: 15.5, fontWeight: '800', color: C.ink },

  card: {
    backgroundColor: C.white, borderWidth: 1, borderColor: C.line,
    borderRadius: 14, overflow: 'hidden', marginTop: 12,
  },
  cardHead: {
    fontSize: 10.5, fontWeight: '800', letterSpacing: 0.9, color: C.mute,
    textTransform: 'uppercase', paddingHorizontal: 15, paddingTop: 12, paddingBottom: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 13, paddingHorizontal: 15,
    borderBottomWidth: 1, borderBottomColor: '#f1f3f7',
  },

  tick: {
    width: 23, height: 23, borderRadius: 7, borderWidth: 1.5, borderColor: C.line,
    marginRight: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: C.white,
  },
  tickOn: { backgroundColor: C.red, borderColor: C.red },
  tickMark: { color: C.white, fontSize: 14, fontWeight: '800', lineHeight: 17 },

  num: { fontSize: 13, fontWeight: '800', color: C.mute, marginRight: 12 },
  payee: { fontSize: 14.5, fontWeight: '700', color: C.ink },
  sub: { fontSize: 11.5, color: C.mute, marginTop: 2 },
  amount: { fontSize: 14.5, fontWeight: '800', color: C.ink, marginLeft: 10 },
  left: { fontSize: 12, fontWeight: '700', color: C.mute },
  leftLow: {
    color: C.red, fontWeight: '800',
    backgroundColor: '#fdecec', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 7,
  },

  number: {
    borderWidth: 1.5, borderColor: C.red, borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    fontSize: 28, fontWeight: '800', letterSpacing: 1, color: C.ink,
    backgroundColor: C.white, marginTop: 5,
  },

  hint: { fontSize: 12, color: C.mute, lineHeight: 17, marginTop: 9 },
  foot: { fontSize: 11.5, color: C.mute, textAlign: 'center', marginTop: 14, lineHeight: 16 },
  empty: { fontSize: 13.5, color: C.mute, lineHeight: 20 },

  doneTitle: { fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  doneSub: { fontSize: 13, color: C.mute, lineHeight: 19, marginTop: 5, marginBottom: 18 },

  warnBox: {
    backgroundColor: '#fdf8ec', borderWidth: 1, borderColor: '#f0dcae',
    borderLeftWidth: 4, borderLeftColor: '#c88a16',
    borderRadius: 10, padding: 11, marginTop: 12,
  },
  warnText: { fontSize: 12, color: '#8a6414', fontWeight: '600', lineHeight: 17 },

  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 11, marginBottom: 13,
  },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700', lineHeight: 18 },
});
