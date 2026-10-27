// A delivery just landed. This is the thirty seconds that stops the invoice
// ending up in a two-week pile on the desk.
//
// Four ways money leaves, and the screen asks which one before anything else,
// because that decides whether a check gets written at the door.

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, SafeAreaView,
  StyleSheet, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { saveInvoice, readPaper, money } from './api';
import { C, S } from './theme';

const METHODS = [
  { key: 'cod',        title: 'COD — I write a check now',   note: 'Check handed over at the door' },
  { key: 'cod_draft',  title: 'COD — they draft my account', note: 'No check. Money leaves today or tomorrow' },
  { key: 'check',      title: 'Charge — I pay by check',     note: 'Invoice goes on terms, check when due' },
  { key: 'auto_debit', title: 'Charge — they draft on terms', note: 'Like C&S and Tony’s. No check ever' },
];

const TERMS = [
  { key: 'net7',  label: '7 days' },
  { key: 'net14', label: '14 days' },
  { key: 'net15', label: '15 days' },
  { key: 'net30', label: '30 days' },
];

export default function DeliveryScreen({ onDone, onCancel }) {
  const [method, setMethod] = useState(null);
  const [vendor, setVendor] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [amount, setAmount] = useState('');
  const [terms, setTerms] = useState('net30');
  const [checkNo, setCheckNo] = useState('');
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState(null);

  const needsCheck = method === 'cod';
  const onTerms = method === 'check' || method === 'auto_debit';

  // People type money the way they write it.
  const readMoney = (t) => {
    const cleaned = String(t || '').replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  };
  const parsed = readMoney(amount);

  const ready =
    method && vendor.trim() && parsed && parsed > 0 && (!needsCheck || checkNo.trim());

  // The whole reason this is on a phone: the invoice is in your hand at the
  // dock. Photograph it there and it never reaches the pile on the desk.
  async function shoot() {
    if (reading) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Camera is off',
        'Razi-Nova needs the camera to read invoices. Turn it on in Settings.'
      );
      return;
    }

    const shot = await ImagePicker.launchCameraAsync({
      base64: true,
      quality: 0.6,              // small enough to send over a store's signal
      allowsEditing: false,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (shot.canceled || !shot.assets || !shot.assets[0]) return;

    const shotAsset = shot.assets[0];
    if (!shotAsset.base64) {
      Alert.alert('Could not read that photo', 'Take it again.');
      return;
    }

    setReading(true);
    setReadNote(null);
    try {
      const res = await readPaper('invoice', shotAsset.base64, shotAsset.mimeType || 'image/jpeg');
      const d = res.draft || {};

      const got = [];
      const missed = [];
      if (d.vendor_name) { setVendor(d.vendor_name); got.push('vendor'); } else missed.push('vendor');
      if (d.total !== null && d.total !== undefined) { setAmount(String(d.total)); got.push('amount'); }
      else missed.push('amount');
      if (d.invoice_number) { setInvoiceNo(d.invoice_number); got.push('invoice number'); }

      // A vendor already on file has its payment method and terms recorded,
      // so there is nothing to choose again.
      if (res.vendor && res.vendor.known && res.vendor.pay_method) {
        setMethod(res.vendor.pay_method);
        if (res.vendor.terms_code) setTerms(res.vendor.terms_code);
      }

      const lines = [];
      if (got.length) lines.push('Read ' + got.join(', ') + '.');
      if (missed.length) lines.push('Could not read ' + missed.join(', ') + '.');
      (d.unreadable || []).forEach((u) => lines.push(u));
      if (res.duplicate) {
        lines.push('This invoice is already recorded — ' +
          (res.duplicate.invoice_date || '') + ', ' + money(res.duplicate.total_amount, true) + '.');
      }
      lines.push('Check the amount against the paper before saving.');

      setReadNote({ tone: res.needs_eyes ? 'check' : 'good', text: lines.join('\n') });
    } catch (e) {
      setReadNote({ tone: 'bad', text: e.message });
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    try {
      await saveInvoice({
        vendor_name: vendor.trim(),
        invoice_number: invoiceNo.trim() || null,
        total: parsed,
        pay_method: method,
        terms_code: onTerms ? terms : 'cod',
        check_number: needsCheck ? checkNo.trim() : null,
      });
      onDone();
    } catch (e) {
      Alert.alert('Could not save it', e.message);
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={st.cancel}>Cancel</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Record a delivery</Text>
        <View style={{ width: 54 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={st.shootBox}>
            <TouchableOpacity
              style={[st.shoot, reading && st.shootBusy]}
              onPress={shoot}
              disabled={reading}
              activeOpacity={0.85}
            >
              {reading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={st.shootText}>Photograph the invoice</Text>
              )}
            </TouchableOpacity>
            <Text style={st.shootNote}>or fill it in below</Text>
            {readNote ? (
              <View style={[st.readOut, st['readOut_' + readNote.tone]]}>
                <Text style={[st.readText, st['readText_' + readNote.tone]]}>{readNote.text}</Text>
              </View>
            ) : null}
          </View>

          <View style={S.card}>
            <Text style={S.label}>How does this vendor get paid?</Text>
            {METHODS.map((m) => (
              <TouchableOpacity
                key={m.key}
                style={[st.choice, method === m.key && st.choiceOn]}
                onPress={() => setMethod(m.key)}
                activeOpacity={0.8}
              >
                <Text style={[st.choiceTitle, method === m.key && { color: C.red }]}>{m.title}</Text>
                <Text style={st.choiceNote}>{m.note}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {method ? (
            <View style={S.card}>
              <Text style={S.label}>Vendor</Text>
              <TextInput
                style={st.input}
                value={vendor}
                onChangeText={setVendor}
                placeholder="Who delivered"
                autoCapitalize="words"
                returnKeyType="next"
              />

              <Text style={[S.label, { marginTop: 14 }]}>Amount</Text>
              <TextInput
                style={[st.input, st.money]}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                keyboardType="decimal-pad"
              />
              {parsed ? <Text style={st.echo}>{money(parsed, true)}</Text> : null}

              <Text style={[S.label, { marginTop: 14 }]}>Invoice number</Text>
              <TextInput
                style={st.input}
                value={invoiceNo}
                onChangeText={setInvoiceNo}
                placeholder="Optional"
                autoCapitalize="characters"
              />

              {needsCheck ? (
                <>
                  <Text style={[S.label, { marginTop: 14 }]}>Check number you are handing over</Text>
                  <TextInput
                    style={st.input}
                    value={checkNo}
                    onChangeText={setCheckNo}
                    placeholder="Required for a COD check"
                    keyboardType="number-pad"
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
                        style={[st.term, terms === t.key && st.termOn]}
                        onPress={() => setTerms(t.key)}
                      >
                        <Text style={[st.termText, terms === t.key && { color: C.white }]}>
                          {t.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : null}

              {method === 'cod_draft' ? (
                <Text style={st.hint}>
                  No check to write. This comes out of the account today or tomorrow, and the
                  dashboard subtracts it straight away.
                </Text>
              ) : null}
              {method === 'auto_debit' ? (
                <Text style={st.hint}>
                  No check to write. The bank pulls it on the due date.
                </Text>
              ) : null}
            </View>
          ) : null}

          {method ? (
            <TouchableOpacity
              style={[S.big, !ready && st.disabled]}
              onPress={save}
              disabled={!ready || saving}
              activeOpacity={0.85}
            >
              {saving ? (
                <ActivityIndicator color={C.white} />
              ) : (
                <Text style={S.bigText}>
                  {needsCheck ? 'Save and record the check' : 'Save this delivery'}
                </Text>
              )}
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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

  choice: { borderWidth: 1, borderColor: C.line, borderRadius: 11, padding: 13, marginTop: 9 },
  choiceOn: { borderColor: C.red, backgroundColor: '#fdf4f4', borderWidth: 2 },
  choiceTitle: { fontSize: 14.5, fontWeight: '700', color: C.ink },
  choiceNote: { fontSize: 12, color: C.mute, marginTop: 3 },

  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 13, paddingVertical: 13, fontSize: 16, color: C.ink, marginTop: 5,
    backgroundColor: C.white,
  },
  money: { fontSize: 22, fontWeight: '700' },
  echo: { fontSize: 12.5, color: C.green, fontWeight: '700', marginTop: 5 },
  hint: { fontSize: 12, color: C.mute, marginTop: 9, lineHeight: 17 },

  terms: { flexDirection: 'row', marginTop: 7 },
  term: {
    flex: 1, paddingVertical: 11, borderRadius: 9, borderWidth: 1,
    borderColor: C.line, alignItems: 'center', marginRight: 7, backgroundColor: C.white,
  },
  termOn: { backgroundColor: C.blue, borderColor: C.blue },
  termText: { fontSize: 13, fontWeight: '700', color: C.ink },

  disabled: { opacity: 0.4 },

  shootBox: {
    borderWidth: 2, borderColor: C.blue, borderStyle: 'dashed',
    borderRadius: 12, padding: 14, marginBottom: 11, backgroundColor: '#f8fbff',
  },
  shoot: {
    backgroundColor: C.blue, borderRadius: 10, paddingVertical: 15, alignItems: 'center',
  },
  shootBusy: { opacity: 0.7 },
  shootText: { color: C.white, fontSize: 15.5, fontWeight: '800' },
  shootNote: { fontSize: 12, color: C.mute, textAlign: 'center', marginTop: 8 },
  readOut: { marginTop: 11, borderRadius: 9, padding: 11 },
  readOut_good: { backgroundColor: '#eef7f2' },
  readOut_check: { backgroundColor: '#fdf8ec' },
  readOut_bad: { backgroundColor: '#fdf1f1' },
  readText: { fontSize: 12.5, lineHeight: 18 },
  readText_good: { color: '#136541' },
  readText_check: { color: '#8a6414' },
  readText_bad: { color: '#a32226' },
});
