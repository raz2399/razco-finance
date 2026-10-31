// Logging a check, in one screen.
//
// It was already possible: Menu, Vendors, search, tap the vendor, Add a
// line, switch it to a payment, fill it in. Six steps to write down
// something that takes four seconds at the desk, which means it does not
// get written down at the desk -- it gets written down later, from
// memory, or not at all.
//
// This is the same action with the vendor search built into it. Type
// enough of the name to find him, the number, the amount, done.
//
// What it does with the money: the server puts the check against his open
// invoices, oldest first, exactly as the vendor screen does. So logging a
// check here also marks the bills it covers as paid. The screen says so
// afterwards, naming how many it settled, because a payment that silently
// closes four invoices is not something to find out about later.

import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator,
  ScrollView, SafeAreaView, StyleSheet, Keyboard,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { findVendors, addVendorPayment, readPaper, money, todayPacific } from './api';
import Notice from './Notice';
import { C, S } from './theme';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());

export default function CheckScreen({ onBack, onDone }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [vendor, setVendor] = useState(null);
  const [searching, setSearching] = useState(false);

  const [number, setNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayPacific());
  const [memo, setMemo] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // What the photograph said, and how much of it the paper vouched for.
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState(null);

  // The search only runs while no vendor is chosen, so picking one does
  // not immediately fire another search for the name just filled in.
  useEffect(() => {
    if (vendor) return undefined;
    const needle = query.trim();
    if (needle.length < 2) { setMatches([]); return undefined; }

    let dead = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await findVendors(needle);
        if (!dead) setMatches((r && r.vendors) || []);
      } catch (e) {
        if (!dead) setMatches([]);
      } finally {
        if (!dead) setSearching(false);
      }
    }, 260);
    return () => { dead = true; clearTimeout(t); };
  }, [query, vendor]);

  function pick(v) {
    setVendor(v);
    setQuery(v.name);
    setMatches([]);
    Keyboard.dismiss();
  }

  function startOver() {
    setRead(null);
    setVendor(null);
    setQuery('');
    setNumber('');
    setAmount('');
    setMemo('');
    setDate(todayPacific());
    setError(null);
  }

  // Photographing the check, which is the point of this screen.
  //
  // A check states its amount twice -- the numeric box and the written
  // line -- so the paper carries its own second opinion and the server
  // compares the two. A stub carries one figure in his handwriting and
  // nothing to check it against, so it comes back as a draft to confirm.
  //
  // Nothing here saves anything. It fills the form in; he still presses
  // the button.
  async function shoot() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError('Razi-Nova needs the camera to read checks. Turn it on in Settings.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({
      base64: true, quality: 0.6, allowsEditing: false,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (shot.canceled || !shot.assets || !shot.assets[0] || !shot.assets[0].base64) return;

    setReading(true);
    setError(null);
    setRead(null);
    try {
      const r = await readPaper('check', shot.assets[0].base64, 'image/jpeg');
      const d = (r && r.draft) || {};
      setRead(r);

      if (d.check_number) setNumber(String(d.check_number));
      if (d.check_date) setDate(d.check_date);
      if (d.memo) setMemo(d.memo);

      // The amount is only filled in when the paper vouched for it. On a
      // disagreement it stays empty on purpose -- a figure in the box is
      // a figure that gets saved without being looked at.
      if (d.amount !== null && d.amount !== undefined) {
        setAmount(String(d.amount));
      }

      if (r && r.vendor) {
        setVendor({ vendor_id: r.vendor.vendor_id, name: r.vendor.name });
        setQuery(r.vendor.name);
      } else if (d.payee) {
        setQuery(d.payee);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setReading(false);
    }
  }

  async function save() {
    const clean = String(amount).replace(/[$,\s]/g, '');
    if (!vendor) { setError('Which vendor is the check to?'); return; }
    if (!clean || isNaN(Number(clean)) || Number(clean) <= 0) {
      setError('How much is the check for?');
      return;
    }
    if (!isDate(date)) { setError('The date needs to read 2026-10-29.'); return; }

    setBusy(true);
    setError(null);
    try {
      const r = await addVendorPayment({
        vendor_id: vendor.vendor_id,
        method: 'check',
        check_number: number,
        amount: clean,
        payment_date: date,
        memo: memo,
      });

      const applied = (r && r.applied_to) || 0;
      const left = (r && r.left_over) || 0;
      setNotice({
        bad: false,
        text: 'Check ' + (number ? '#' + number + ' ' : '') +
          money(clean, true) + ' to ' + vendor.name + '. ' +
          (applied
            ? 'Put against ' + applied + ' invoice' + (applied > 1 ? 's' : '') + '.'
            : 'Not against any invoice.') +
          (left > 0 ? ' ' + money(left, true) + ' of it is still unapplied.' : ''),
      });

      startOver();
      if (onDone) onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={st.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Log a check</Text>
        <View style={{ width: 56 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? (
          <View style={st.errorBox}><Text style={st.errorText}>{error}</Text></View>
        ) : null}

        <TouchableOpacity
          style={[st.shoot, reading && { opacity: 0.6 }]}
          onPress={shoot}
          disabled={reading || busy}
          activeOpacity={0.85}
        >
          {reading
            ? <ActivityIndicator color={C.red} />
            : <Text style={st.shootText}>Photograph the check</Text>}
        </TouchableOpacity>
        <Text style={st.shootHint}>
          Or fill it in below. The photo only fills the boxes &mdash; nothing is
          saved until you press the button.
        </Text>

        {read ? (
          <View
            style={[
              st.verdict,
              read.trust === 'verified' ? st.verdictGood : st.verdictWarn,
            ]}
          >
            <Text
              style={[
                st.verdictTitle,
                { color: read.trust === 'verified' ? '#176b33' : '#8a6212' },
              ]}
            >
              {read.trust === 'verified'
                ? 'The check says the amount twice and both agree'
                : read.trust === 'conflict'
                  ? 'The two amounts do not agree'
                  : 'Only one amount on this one'}
            </Text>
            {(read.why || []).map((w, i) => (
              <Text key={i} style={st.verdictLine}>{w}</Text>
            ))}
            {read.trust !== 'verified' ? (
              <Text style={st.verdictLine}>Check it against the paper before saving.</Text>
            ) : null}
          </View>
        ) : null}

        <Text style={S.label}>Who is it to</Text>
        <View>
          <TextInput
            style={[st.input, vendor && st.inputPicked]}
            value={query}
            onChangeText={(v) => { setQuery(v); setVendor(null); setError(null); }}
            placeholder="Start typing the name"
            placeholderTextColor="#b6bcc8"
            autoCorrect={false}
          />
          {vendor ? (
            <TouchableOpacity
              style={st.clear}
              onPress={startOver}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={st.clearText}>✕</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {!vendor && matches.length ? (
          <View style={st.matches}>
            {matches.slice(0, 7).map((v) => (
              <TouchableOpacity
                key={v.vendor_id}
                style={st.match}
                onPress={() => pick(v)}
                activeOpacity={0.6}
              >
                <Text style={st.matchName} numberOfLines={1}>{v.name}</Text>
                {v.owed ? (
                  <Text style={st.matchOwed}>{money(v.owed)} open</Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {!vendor && searching ? (
          <Text style={st.hint}>Looking…</Text>
        ) : null}

        {vendor && vendor.owed ? (
          <Text style={st.hint}>
            {money(vendor.owed, true)} open with {vendor.name}. The check goes
            against the oldest bills first.
          </Text>
        ) : null}

        <View style={st.pair}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={S.label}>Check number</Text>
            <TextInput
              style={st.input}
              value={number}
              onChangeText={setNumber}
              placeholder="9801"
              placeholderTextColor="#b6bcc8"
              keyboardType="number-pad"
            />
          </View>
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={S.label}>Amount</Text>
            <TextInput
              style={st.input}
              value={amount}
              onChangeText={(v) => { setAmount(v); setError(null); }}
              placeholder="0.00"
              placeholderTextColor="#b6bcc8"
              keyboardType="decimal-pad"
            />
          </View>
        </View>

        <Text style={[S.label, { marginTop: 14 }]}>Date</Text>
        <TextInput
          style={st.input}
          value={date}
          onChangeText={setDate}
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
        />

        <Text style={[S.label, { marginTop: 14 }]}>What for</Text>
        <TextInput
          style={st.input}
          value={memo}
          onChangeText={setMemo}
          placeholder="invoice 4471"
          placeholderTextColor="#b6bcc8"
        />

        <TouchableOpacity
          style={[S.big, { marginTop: 22 }, busy && { opacity: 0.5 }]}
          onPress={save}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy
            ? <ActivityIndicator color={C.white} />
            : <Text style={S.bigText}>Log the check</Text>}
        </TouchableOpacity>

        <Text style={st.foot}>
          It goes down as written, not cashed. When the bank takes it, it
          clears itself off.
        </Text>
      </ScrollView>

      <Notice notice={notice} onClose={() => setNotice(null)} />
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  shoot: {
    borderWidth: 1.5, borderColor: C.red, borderStyle: 'dashed', borderRadius: 12,
    paddingVertical: 16, alignItems: 'center', backgroundColor: '#fff',
    marginBottom: 7,
  },
  shootText: { fontSize: 15, fontWeight: '800', color: C.red },
  shootHint: { fontSize: 11.5, color: C.mute, lineHeight: 16, marginBottom: 14 },

  verdict: { borderWidth: 1, borderRadius: 10, padding: 11, marginBottom: 14 },
  verdictGood: { backgroundColor: '#f1f9f3', borderColor: '#bfe4ca' },
  verdictWarn: { backgroundColor: '#fdf8ec', borderColor: '#f0dcae' },
  verdictTitle: { fontSize: 13, fontWeight: '800', marginBottom: 4 },
  verdictLine: { fontSize: 12, color: C.ink, lineHeight: 17, marginTop: 2 },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  back: { color: C.blue, fontSize: 15, fontWeight: '700', width: 56 },
  barTitle: { flex: 1, textAlign: 'center', fontSize: 15.5, fontWeight: '800', color: C.ink },

  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 13, fontSize: 16, color: C.ink,
    backgroundColor: C.white, marginTop: 5,
  },
  inputPicked: { borderColor: C.green, paddingRight: 40 },
  clear: { position: 'absolute', right: 10, top: 18 },
  clearText: { fontSize: 15, color: C.mute, fontWeight: '800' },

  matches: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    backgroundColor: C.white, marginTop: 7, overflow: 'hidden',
  },
  match: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 13,
    borderBottomWidth: 1, borderBottomColor: '#f1f3f7',
  },
  matchName: { flex: 1, fontSize: 14.5, fontWeight: '600', color: C.ink },
  matchOwed: { fontSize: 12.5, fontWeight: '700', color: C.mute, marginLeft: 10 },

  hint: { fontSize: 12, color: C.mute, marginTop: 7, lineHeight: 17 },
  pair: { flexDirection: 'row', marginTop: 14 },

  foot: { fontSize: 11.5, color: C.mute, textAlign: 'center', marginTop: 16, lineHeight: 16 },

  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 11, marginBottom: 13,
  },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
});
