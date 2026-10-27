// A delivery landed — usually several at once.
//
// This is a stack, not a form. Photograph one invoice after another, or
// pick a batch from the camera roll, then look down the list and save them
// together. That matches what actually happens at the dock: a driver hands
// over a pile, not one sheet.
//
// Nothing read from a photograph is saved on its own. Every line stays on
// screen until it is saved, and anything that could not be read is marked
// so it cannot slip through unnoticed.

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, SafeAreaView,
  StyleSheet, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { saveInvoice, readPaper, money } from './api';
import { C, S } from './theme';

const METHODS = [
  { key: 'cod',        title: 'COD — I write a check now',    note: 'Check handed over at the door' },
  { key: 'cod_draft',  title: 'COD — they draft my account',  note: 'No check. Money leaves today or tomorrow' },
  { key: 'check',      title: 'Charge — I pay by check',      note: 'Invoice goes on terms, check when due' },
  { key: 'auto_debit', title: 'Charge — they draft on terms', note: 'Like C&S and Tony’s. No check ever' },
];

const TERMS = [
  { key: 'net7',  label: '7 days' },
  { key: 'net14', label: '14 days' },
  { key: 'net15', label: '15 days' },
  { key: 'net30', label: '30 days' },
];

const readMoney = (t) => {
  const cleaned = String(t == null ? '' : t).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
};

let seq = 0;
const blank = (over) => Object.assign({
  id: ++seq,
  vendor: '',
  invoiceNo: '',
  amount: '',
  method: null,
  terms: 'net30',
  checkNo: '',
  thumb: null,
  notes: [],
  tone: null,
  vendorKnown: false,
  status: 'draft',   // draft | saving | saved | failed
  error: null,
  open: true,
}, over || {});

// What the server insists on. Checking here means a stack of twelve does
// not fail one at a time with a dialog each.
function whatIsMissing(d) {
  const missing = [];
  if (!String(d.vendor).trim()) missing.push('vendor');
  if (!String(d.invoiceNo).trim()) missing.push('invoice number');
  const amt = readMoney(d.amount);
  if (amt === null || amt <= 0) missing.push('amount');
  if (!d.method) missing.push('how it gets paid');
  if (d.method === 'cod' && !String(d.checkNo).trim()) missing.push('check number');
  return missing;
}

export default function DeliveryScreen({ onDone, onCancel }) {
  const [items, setItems] = useState([blank()]);
  const [reading, setReading] = useState(false);
  const [savingAll, setSavingAll] = useState(false);

  const update = (id, patch) =>
    setItems((list) => list.map((d) => (d.id === id ? Object.assign({}, d, patch) : d)));

  const remove = (id) =>
    setItems((list) => (list.length === 1 ? [blank()] : list.filter((d) => d.id !== id)));

  const unsaved = items.filter((d) => d.status !== 'saved');
  const saved = items.filter((d) => d.status === 'saved');
  const readyCount = unsaved.filter((d) => whatIsMissing(d).length === 0).length;

  // ---- turning a photo into a line on the stack -------------------------
  async function ingest(asset) {
    const placeholder = blank({ thumb: asset.uri, tone: 'working', notes: ['Reading…'], open: false });
    setItems((list) => {
      // reuse the empty first line rather than leaving a blank above the stack
      const onlyBlank = list.length === 1 && list[0].status === 'draft' &&
        !list[0].vendor && !list[0].amount && !list[0].thumb;
      return onlyBlank ? [placeholder] : list.concat([placeholder]);
    });

    try {
      const res = await readPaper('invoice', asset.base64, asset.mimeType || 'image/jpeg');
      const d = res.draft || {};
      const notes = [];
      const missed = [];

      if (!d.vendor_name) missed.push('vendor');
      if (d.total === null || d.total === undefined) missed.push('amount');
      if (!d.invoice_number) missed.push('invoice number');
      if (missed.length) notes.push('Could not read ' + missed.join(', ') + '.');
      (d.unreadable || []).forEach((u) => notes.push(u));
      if (res.duplicate) {
        notes.push('Already recorded — ' + (res.duplicate.invoice_date || '') + ', ' +
                   money(res.duplicate.total_amount, true) + '.');
      }

      const known = res.vendor && res.vendor.known;
      if (known) notes.push(res.vendor.name + ' is on file. Terms already set.');
      else if (d.terms_text) notes.push('Invoice says terms are “' + d.terms_text + '”.');

      update(placeholder.id, {
        vendor: d.vendor_name || '',
        invoiceNo: d.invoice_number || '',
        amount: d.total === null || d.total === undefined ? '' : String(d.total),
        method: known && res.vendor.pay_method ? res.vendor.pay_method : null,
        terms: known && res.vendor.terms_code ? res.vendor.terms_code : 'net30',
        vendorKnown: !!known,
        notes,
        tone: res.needs_eyes || missed.length ? 'check' : 'good',
        open: res.needs_eyes || missed.length > 0,
      });
    } catch (e) {
      update(placeholder.id, { tone: 'bad', notes: [e.message], open: true });
    }
  }

  async function shootOne() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera is off', 'Razi-Nova needs the camera to read invoices. Turn it on in Settings.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({
      base64: true, quality: 0.6, allowsEditing: false,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (shot.canceled || !shot.assets || !shot.assets[0] || !shot.assets[0].base64) return;
    setReading(true);
    try { await ingest(shot.assets[0]); } finally { setReading(false); }
  }

  async function pickMany() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photos is off', 'Turn on photo access in Settings to pick invoices you already shot.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      base64: true, quality: 0.6, allowsMultipleSelection: true, selectionLimit: 12,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (picked.canceled || !picked.assets) return;
    setReading(true);
    try {
      // one at a time, so a slow signal does not fire twelve at once
      for (const a of picked.assets) {
        if (a.base64) await ingest(a);
      }
    } finally { setReading(false); }
  }

  // ---- saving the stack --------------------------------------------------
  async function saveAll() {
    const todo = unsaved.filter((d) => whatIsMissing(d).length === 0);
    if (!todo.length || savingAll) return;

    setSavingAll(true);
    let ok = 0;
    for (const d of todo) {
      update(d.id, { status: 'saving', error: null });
      try {
        await saveInvoice({
          vendor: String(d.vendor).trim(),
          invoice_number: String(d.invoiceNo).trim(),
          total_amount: readMoney(d.amount),
          pay_method: d.method,
          terms_code: d.method === 'cod' || d.method === 'cod_draft' ? 'cod' : d.terms,
          check_number: d.method === 'cod' ? String(d.checkNo).trim() : null,
        });
        update(d.id, { status: 'saved', open: false });
        ok += 1;
      } catch (e) {
        // One bad invoice must not stop the other eleven.
        update(d.id, { status: 'failed', error: e.message, open: true });
      }
    }
    setSavingAll(false);

    const failed = todo.length - ok;
    if (failed === 0) {
      onDone();
    } else {
      Alert.alert(
        ok ? 'Saved ' + ok + ' of ' + todo.length : 'Nothing saved',
        failed + (failed === 1 ? ' invoice is' : ' invoices are') +
        ' still on the list with the reason shown.'
      );
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={st.cancel}>Cancel</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Record deliveries</Text>
        <View style={{ width: 54 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 140 }} keyboardShouldPersistTaps="handled">

          <View style={st.shootBox}>
            <TouchableOpacity
              style={[st.shoot, reading && st.busy]}
              onPress={shootOne}
              disabled={reading}
              activeOpacity={0.85}
            >
              {reading ? <ActivityIndicator color="#fff" />
                       : <Text style={st.shootText}>Photograph an invoice</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[st.shootAlt, reading && st.busy]}
              onPress={pickMany}
              disabled={reading}
              activeOpacity={0.85}
            >
              <Text style={st.shootAltText}>Pick several from photos</Text>
            </TouchableOpacity>

            <Text style={st.shootNote}>
              Take them one after another. They stack up below and save together.
            </Text>
          </View>

          {items.map((d, i) => (
            <Card
              key={d.id}
              d={d}
              index={i + 1}
              onChange={(patch) => update(d.id, patch)}
              onRemove={() => remove(d.id)}
            />
          ))}

          <TouchableOpacity style={st.addRow} onPress={() => setItems((l) => l.concat([blank()]))}>
            <Text style={st.addText}>+ Add one by hand</Text>
          </TouchableOpacity>
        </ScrollView>

        <View style={st.footer}>
          {saved.length ? (
            <Text style={st.footerNote}>{saved.length} saved</Text>
          ) : null}
          <TouchableOpacity
            style={[S.big, (!readyCount || savingAll) && st.disabled]}
            onPress={saveAll}
            disabled={!readyCount || savingAll}
            activeOpacity={0.85}
          >
            {savingAll ? <ActivityIndicator color={C.white} /> : (
              <Text style={S.bigText}>
                {readyCount
                  ? 'Save ' + readyCount + (readyCount === 1 ? ' delivery' : ' deliveries')
                  : 'Fill in what is missing'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Card({ d, index, onChange, onRemove }) {
  const missing = whatIsMissing(d);
  const amt = readMoney(d.amount);
  const needsCheck = d.method === 'cod';
  const onTerms = d.method === 'check' || d.method === 'auto_debit';
  const isSaved = d.status === 'saved';

  return (
    <View style={[S.card, isSaved && st.cardSaved, d.status === 'failed' && st.cardFailed]}>
      <TouchableOpacity
        style={st.head}
        onPress={() => onChange({ open: !d.open })}
        activeOpacity={0.7}
        disabled={isSaved}
      >
        {d.thumb ? <Image source={{ uri: d.thumb }} style={st.thumb} /> : null}
        <View style={{ flex: 1 }}>
          <Text style={st.headName} numberOfLines={1}>
            {d.vendor || 'Invoice ' + index}
          </Text>
          <Text style={st.headSub}>
            {amt !== null ? money(amt, true) : 'no amount yet'}
            {d.invoiceNo ? ' · ' + d.invoiceNo : ''}
          </Text>
        </View>
        {isSaved ? <Text style={st.savedTag}>SAVED</Text>
          : d.status === 'saving' ? <ActivityIndicator color={C.blue} />
          : missing.length ? <Text style={st.needTag}>NEEDS {missing.length}</Text>
          : <Text style={st.readyTag}>READY</Text>}
      </TouchableOpacity>

      {d.notes && d.notes.length && !isSaved ? (
        <View style={[st.notes, st['notes_' + (d.tone || 'check')]]}>
          {d.notes.map((n, k) => (
            <Text key={k} style={[st.notesText, st['notesText_' + (d.tone || 'check')]]}>{n}</Text>
          ))}
        </View>
      ) : null}

      {d.error ? <Text style={st.err}>{d.error}</Text> : null}

      {d.open && !isSaved ? (
        <View style={{ marginTop: 12 }}>
          <Text style={S.label}>Vendor</Text>
          <TextInput
            style={st.input} value={d.vendor}
            onChangeText={(v) => onChange({ vendor: v })}
            placeholder="Who delivered" autoCapitalize="words"
          />

          <View style={{ flexDirection: 'row', marginTop: 12 }}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={S.label}>Amount</Text>
              <TextInput
                style={[st.input, st.money]} value={String(d.amount)}
                onChangeText={(v) => onChange({ amount: v })}
                placeholder="0.00" keyboardType="decimal-pad"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={S.label}>Invoice number</Text>
              <TextInput
                style={st.input} value={d.invoiceNo}
                onChangeText={(v) => onChange({ invoiceNo: v })}
                placeholder="Required" autoCapitalize="characters"
              />
            </View>
          </View>

          <Text style={[S.label, { marginTop: 14 }]}>
            {d.vendorKnown ? 'How this vendor gets paid' : 'How does this vendor get paid?'}
          </Text>
          {METHODS.map((m) => (
            <TouchableOpacity
              key={m.key}
              style={[st.choice, d.method === m.key && st.choiceOn]}
              onPress={() => onChange({ method: m.key })}
              activeOpacity={0.8}
            >
              <Text style={[st.choiceTitle, d.method === m.key && { color: C.red }]}>{m.title}</Text>
              <Text style={st.choiceNote}>{m.note}</Text>
            </TouchableOpacity>
          ))}

          {needsCheck ? (
            <>
              <Text style={[S.label, { marginTop: 14 }]}>Check number you are handing over</Text>
              <TextInput
                style={st.input} value={d.checkNo}
                onChangeText={(v) => onChange({ checkNo: v })}
                placeholder="Required for a COD check" keyboardType="number-pad"
              />
              <Text style={st.hint}>
                A COD check is not recorded without its number, so the bank can match it later.
              </Text>
            </>
          ) : null}

          {onTerms ? (
            <>
              <Text style={[S.label, { marginTop: 14 }]}>Terms</Text>
              <View style={st.terms}>
                {TERMS.map((t) => (
                  <TouchableOpacity
                    key={t.key}
                    style={[st.term, d.terms === t.key && st.termOn]}
                    onPress={() => onChange({ terms: t.key })}
                  >
                    <Text style={[st.termText, d.terms === t.key && { color: C.white }]}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}

          {d.method === 'cod_draft' ? (
            <Text style={st.hint}>No check to write. This leaves the account today or tomorrow.</Text>
          ) : null}
          {d.method === 'auto_debit' ? (
            <Text style={st.hint}>No check to write. The bank pulls it on the due date.</Text>
          ) : null}

          <TouchableOpacity onPress={onRemove} style={st.removeRow}>
            <Text style={st.removeText}>Remove this one</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  barTitle: { fontSize: 16, fontWeight: '800', color: C.ink },
  cancel: { fontSize: 15, color: C.blue, fontWeight: '600', width: 54 },

  shootBox: {
    borderWidth: 2, borderColor: C.blue, borderStyle: 'dashed',
    borderRadius: 12, padding: 14, marginBottom: 12, backgroundColor: '#f8fbff',
  },
  shoot: { backgroundColor: C.blue, borderRadius: 10, paddingVertical: 15, alignItems: 'center' },
  shootText: { color: C.white, fontSize: 15.5, fontWeight: '800' },
  shootAlt: {
    marginTop: 8, borderRadius: 10, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1, borderColor: C.blue, backgroundColor: C.white,
  },
  shootAltText: { color: C.blue, fontSize: 14, fontWeight: '700' },
  shootNote: { fontSize: 12, color: C.mute, textAlign: 'center', marginTop: 9, lineHeight: 17 },
  busy: { opacity: 0.7 },

  head: { flexDirection: 'row', alignItems: 'center' },
  thumb: { width: 38, height: 38, borderRadius: 7, marginRight: 10, backgroundColor: '#eee' },
  headName: { fontSize: 15, fontWeight: '700', color: C.ink },
  headSub: { fontSize: 12, color: C.mute, marginTop: 2 },
  savedTag: { fontSize: 10, fontWeight: '800', color: C.green, letterSpacing: 0.6 },
  readyTag: { fontSize: 10, fontWeight: '800', color: C.blue, letterSpacing: 0.6 },
  needTag: { fontSize: 10, fontWeight: '800', color: C.amber, letterSpacing: 0.6 },
  cardSaved: { opacity: 0.6 },
  cardFailed: { borderColor: C.red },

  notes: { marginTop: 10, borderRadius: 9, padding: 10 },
  notes_good: { backgroundColor: '#eef7f2' },
  notes_check: { backgroundColor: '#fdf8ec' },
  notes_bad: { backgroundColor: '#fdf1f1' },
  notes_working: { backgroundColor: '#eef4fb' },
  notesText: { fontSize: 12, lineHeight: 17 },
  notesText_good: { color: '#136541' },
  notesText_check: { color: '#8a6414' },
  notesText_bad: { color: '#a32226' },
  notesText_working: { color: '#2c5c96' },
  err: { marginTop: 9, fontSize: 12.5, color: C.red, fontWeight: '600' },

  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 13, paddingVertical: 12, fontSize: 16, color: C.ink,
    marginTop: 5, backgroundColor: C.white,
  },
  money: { fontSize: 19, fontWeight: '700' },
  hint: { fontSize: 12, color: C.mute, marginTop: 9, lineHeight: 17 },

  choice: { borderWidth: 1, borderColor: C.line, borderRadius: 11, padding: 12, marginTop: 8 },
  choiceOn: { borderColor: C.red, backgroundColor: '#fdf4f4', borderWidth: 2 },
  choiceTitle: { fontSize: 14, fontWeight: '700', color: C.ink },
  choiceNote: { fontSize: 11.5, color: C.mute, marginTop: 3 },

  terms: { flexDirection: 'row', marginTop: 7 },
  term: {
    flex: 1, paddingVertical: 11, borderRadius: 9, borderWidth: 1,
    borderColor: C.line, alignItems: 'center', marginRight: 7, backgroundColor: C.white,
  },
  termOn: { backgroundColor: C.blue, borderColor: C.blue },
  termText: { fontSize: 13, fontWeight: '700', color: C.ink },

  removeRow: { marginTop: 14, alignItems: 'center' },
  removeText: { fontSize: 13, color: C.red, fontWeight: '600' },

  addRow: { alignItems: 'center', paddingVertical: 14 },
  addText: { fontSize: 14, color: C.blue, fontWeight: '700' },

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: 12, paddingBottom: 26,
    backgroundColor: C.white, borderTopWidth: 1, borderTopColor: C.line,
  },
  footerNote: { fontSize: 12, color: C.green, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  disabled: { opacity: 0.4 },
});
