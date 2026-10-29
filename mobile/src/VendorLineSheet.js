// Putting a line on a vendor, or correcting one, from the phone.
//
// One sheet for both, because they are the same six boxes and a second
// screen that looks almost the same is a second screen to get wrong.
//
// The thing it is careful about: "already paid" does NOT write a payment.
// A bill settled in QuickBooks or before the switchover had its money
// leave somewhere else. Recording a check here to explain it would put a
// payment in the bank reconciliation that never happened, and count the
// cost twice. So the box says what it does -- it comes off what he owes,
// and no check is written.

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, Modal,
  ScrollView, SafeAreaView, StyleSheet,
} from 'react-native';
import {
  addVendorInvoice, addVendorPayment, editVendorLine, voidVendorLine, todayPacific,
} from './api';
import Confirm from './Confirm';
import { C, S } from './theme';

// Plain words for what the database calls things. He should never have to
// read "partially_paid" off his own screen.
const INVOICE_STATUS = [
  { key: 'approved', label: 'Open' },
  { key: 'partially_paid', label: 'Part paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'needs_review', label: 'Needs a look' },
  { key: 'disputed', label: 'Disputed' },
];

const PAYMENT_STATUS = [
  { key: 'outstanding', label: 'Not cashed' },
  { key: 'cleared', label: 'Cleared' },
  { key: 'stopped', label: 'Stopped' },
];

const PAY_TYPE = [
  { key: 'charge_account', label: 'Charge' },
  { key: 'check', label: 'Check' },
  { key: 'cod', label: 'COD' },
  { key: 'auto_debit', label: 'Auto-draft' },
];

const METHODS = [
  { key: 'check', label: 'Check' },
  { key: 'ach', label: 'ACH' },
  { key: 'auto_debit', label: 'Draft' },
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'wire', label: 'Wire' },
];

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());

export default function VendorLineSheet({ visible, vendor, editing, onClose, onSaved, onFailed }) {
  const correcting = !!editing;
  const startKind = correcting ? editing.kind : 'invoice';

  const [kind, setKind] = useState(startKind);
  const [date, setDate] = useState('');
  const [number, setNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState('');
  const [method, setMethod] = useState('check');
  const [note, setNote] = useState('');
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  // Everything else the server will take. Shown when correcting a line,
  // because a correction is exactly the moment any of them may be the
  // thing that is wrong.
  const [paidSoFar, setPaidSoFar] = useState('');
  const [status, setStatus] = useState('');
  const [payType, setPayType] = useState('');
  const [received, setReceived] = useState('');
  const [cleared, setCleared] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loadedFor, setLoadedFor] = useState(null);
  // Asked inside the sheet, by the sheet. Alert.alert called from within a
  // Modal is the case that does not present at all -- see Confirm.js.
  const [ask, setAsk] = useState(null);

  // Fill the boxes when the sheet opens, and only then -- resetting on
  // every render would wipe what he is typing.
  const openKey = (visible ? 'open' : 'shut') + ':' + (editing ? editing.id : 'new');
  if (visible && loadedFor !== openKey) {
    setLoadedFor(openKey);
    setError(null);
    setBusy(false);
    if (correcting) {
      setKind(editing.kind);
      setDate(editing.date || '');
      setNumber(editing.number || '');
      setAmount(String(
        editing.face_amount != null ? editing.face_amount
          : editing.kind === 'payment' ? editing.paid : editing.charge));
      setDue(editing.due_date || '');
      setNote((editing.kind === 'payment' ? editing.memo : editing.note) || '');
      setAlreadyPaid(false);
      setStatus(editing.status || '');
      setPayType(editing.method || '');
      setMethod(editing.method && editing.kind === 'payment' ? editing.method : 'check');
      setReceived(editing.received_date || '');
      setCleared(editing.cleared_date || '');
      // What has been paid against it so far, whether through this system
      // or settled elsewhere. Editable, because a part payment keyed wrong
      // is as common as an amount keyed wrong.
      setPaidSoFar(String(
        editing.kind === 'invoice'
          ? Math.round(((Number(editing.face_amount) || 0) -
                        (Number(editing.balance_due) || 0)) * 100) / 100
          : ''));
    } else {
      setKind('invoice');
      setDate(todayPacific());
      setNumber('');
      setAmount('');
      setDue('');
      setMethod('check');
      setNote('');
      setAlreadyPaid(false);
      setPaidSoFar(''); setStatus(''); setPayType(''); setReceived(''); setCleared('');
    }
  }

  const paying = kind === 'payment';

  async function save() {
    const money = String(amount).replace(/[$,\s]/g, '');
    if (!money || isNaN(Number(money)) || Number(money) <= 0) {
      setError('How much is it for?');
      return;
    }
    if (date && !isDate(date)) {
      setError('The date needs to read 2026-10-29.');
      return;
    }
    if (due && !isDate(due)) {
      setError('The due date needs to read 2026-10-29.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      let r;
      if (correcting) {
        // Everything the server will take, so a correction can reach
        // whichever field is actually the wrong one.
        const fields = paying
          ? {
              payment_date: date, check_number: number, amount: money, memo: note,
              method, status, cleared_date: cleared,
            }
          : {
              invoice_date: date, invoice_number: number, total_amount: money,
              due_date: due, notes: note, received_date: received,
              amount_paid: String(paidSoFar).replace(/[$,\s]/g, ''),
              status, payment_type: payType,
            };
        r = await editVendorLine(kind, editing.id, fields);
      } else if (paying) {
        r = await addVendorPayment({
          vendor_id: vendor.vendor_id,
          payment_date: date, amount: money,
          method, check_number: number, memo: note,
        });
      } else {
        r = await addVendorInvoice({
          vendor_id: vendor.vendor_id,
          invoice_date: date, invoice_number: number, total_amount: money,
          due_date: due, notes: note,
          // Straight in settled: on the books for the record, off what he
          // owes, and no check invented to explain where the money went.
          amount_paid: alreadyPaid ? money : '',
        });
      }
      onSaved(r && r.says);
    } catch (e) {
      // The same invoice number twice is nearly always the same bill. The
      // server stops it and says which one it clashes with; he decides.
      if (/already on/i.test(e.message || '')) {
        setBusy(false);
        setAsk({
          title: 'Already on the books',
          body: e.message,
          no: 'Leave it',
          yes: 'Enter it anyway',
          run: async () => {
            const r = await addVendorInvoice({
              vendor_id: vendor.vendor_id,
              invoice_date: date, invoice_number: number, total_amount: money,
              due_date: due, notes: note,
              amount_paid: alreadyPaid ? money : '',
              allow_duplicate: true,
            });
            onSaved(r && r.says);
          },
        });
        return;
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function killIt() {
    setAsk({
      title: 'Void this line',
      body: 'It stays on the ledger marked void and counts nothing. Nothing '
          + 'is deleted. If a check is voided, whatever it paid goes back to '
          + 'being owed.',
      no: 'Keep it',
      yes: 'Void it',
      danger: true,
      run: async () => {
        const r = await voidVendorLine(kind, editing.id, 'Voided from the phone');
        onSaved(r && r.says);
      },
    });
  }

  // One place where a confirmed action runs, so a failure can never end
  // in silence: it either saves, or it says why on this sheet.
  async function runAsked() {
    const job = ask;
    setAsk(null);
    setBusy(true);
    try {
      await job.run();
    } catch (e) {
      setError(e.message);
      if (onFailed) onFailed(e.message);
    } finally {
      setBusy(false);
    }
  }


  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={st.bar}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={st.cancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={st.barTitle} numberOfLines={1}>
            {correcting ? 'Fix a line' : 'Add a line'}
          </Text>
          <View style={{ width: 56 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
          <Text style={st.vendor} numberOfLines={1}>{vendor ? vendor.name : ''}</Text>

          {error ? (
            <View style={st.errorBox}><Text style={st.errorText}>{error}</Text></View>
          ) : null}

          {!correcting ? (
            <View style={st.chipRow}>
              <Chip on={!paying} label="A bill from them" onPress={() => setKind('invoice')} />
              <Chip on={paying} label="A payment to them" onPress={() => setKind('payment')} />
            </View>
          ) : null}

          <Text style={S.label}>Date</Text>
          <TextInput style={st.input} value={date} onChangeText={setDate}
                     placeholder="2026-10-29" placeholderTextColor="#b6bcc8"
                     autoCorrect={false} keyboardType="numbers-and-punctuation" />

          <Text style={[S.label, { marginTop: 13 }]}>
            {paying ? 'Check number' : 'Invoice number'}
          </Text>
          <TextInput style={st.input} value={number} onChangeText={setNumber}
                     autoCapitalize="characters" autoCorrect={false} />

          <Text style={[S.label, { marginTop: 13 }]}>Amount</Text>
          <TextInput style={st.input} value={amount} onChangeText={setAmount}
                     placeholder="0.00" placeholderTextColor="#b6bcc8"
                     keyboardType="decimal-pad" />

          {!paying ? (
            <>
              <Text style={[S.label, { marginTop: 13 }]}>Due — leave blank to use their terms</Text>
              <TextInput style={st.input} value={due} onChangeText={setDue}
                         placeholder="2026-11-13" placeholderTextColor="#b6bcc8"
                         autoCorrect={false} keyboardType="numbers-and-punctuation" />
            </>
          ) : null}

          {paying && !correcting ? (
            <>
              <Text style={[S.label, { marginTop: 13 }]}>How was it paid</Text>
              <View style={st.chipRow}>
                {METHODS.map((m) => (
                  <Chip key={m.key} on={method === m.key} label={m.label}
                        onPress={() => setMethod(m.key)} small />
                ))}
              </View>
            </>
          ) : null}

          {correcting && !paying ? (
            <>
              <Text style={[S.label, { marginTop: 13 }]}>Paid against it so far</Text>
              <TextInput style={st.input} value={paidSoFar} onChangeText={setPaidSoFar}
                         placeholder="0.00" placeholderTextColor="#b6bcc8"
                         keyboardType="decimal-pad" />
              <Text style={st.hint}>
                What is left is worked out from this — the amount less what is paid.
              </Text>

              <Text style={[S.label, { marginTop: 13 }]}>Received</Text>
              <TextInput style={st.input} value={received} onChangeText={setReceived}
                         placeholder="2026-10-29" placeholderTextColor="#b6bcc8"
                         autoCorrect={false} keyboardType="numbers-and-punctuation" />

              <Text style={[S.label, { marginTop: 13 }]}>How it gets paid</Text>
              <View style={st.chipRow}>
                {PAY_TYPE.map((m) => (
                  <Chip key={m.key} on={payType === m.key} label={m.label}
                        onPress={() => setPayType(m.key)} small />
                ))}
              </View>

              <Text style={[S.label, { marginTop: 13 }]}>Where it stands</Text>
              <View style={st.chipRow}>
                {INVOICE_STATUS.map((m) => (
                  <Chip key={m.key} on={status === m.key} label={m.label}
                        onPress={() => setStatus(m.key)} small />
                ))}
              </View>
            </>
          ) : null}

          {correcting && paying ? (
            <>
              <Text style={[S.label, { marginTop: 13 }]}>How it was paid</Text>
              <View style={st.chipRow}>
                {METHODS.map((m) => (
                  <Chip key={m.key} on={method === m.key} label={m.label}
                        onPress={() => setMethod(m.key)} small />
                ))}
              </View>

              <Text style={[S.label, { marginTop: 13 }]}>Where it stands</Text>
              <View style={st.chipRow}>
                {PAYMENT_STATUS.map((m) => (
                  <Chip key={m.key} on={status === m.key} label={m.label}
                        onPress={() => setStatus(m.key)} small />
                ))}
              </View>

              <Text style={[S.label, { marginTop: 13 }]}>Cleared the bank on</Text>
              <TextInput style={st.input} value={cleared} onChangeText={setCleared}
                         placeholder="blank until it clears" placeholderTextColor="#b6bcc8"
                         autoCorrect={false} keyboardType="numbers-and-punctuation" />
            </>
          ) : null}

          <Text style={[S.label, { marginTop: 13 }]}>Note</Text>
          <TextInput style={st.input} value={note} onChangeText={setNote} />

          {!paying && !correcting ? (
            <TouchableOpacity
              style={st.check}
              onPress={() => setAlreadyPaid(!alreadyPaid)}
              activeOpacity={0.7}
            >
              <View style={[st.box, alreadyPaid && st.boxOn]}>
                {alreadyPaid ? <Text style={st.tick}>✓</Text> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.checkLabel}>It is already paid</Text>
                <Text style={st.checkSub}>
                  Goes on the books for the record but not onto what you owe.
                  No check is written, because the money did not leave through here.
                </Text>
              </View>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            style={[S.big, { marginTop: 20 }, busy && { opacity: 0.5 }]}
            onPress={save}
            disabled={busy}
            activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color={C.white} />
                  : <Text style={S.bigText}>{correcting ? 'Save the correction' : 'Save it'}</Text>}
          </TouchableOpacity>

          {correcting ? (
            <TouchableOpacity style={st.void} onPress={killIt} disabled={busy} activeOpacity={0.7}>
              <Text style={st.voidText}>Void this line</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
        <Confirm
          ask={ask}
          busy={busy}
          onNo={() => setAsk(null)}
          onYes={runAsked}
        />
      </SafeAreaView>
    </Modal>
  );
}

function Chip({ on, label, onPress, small }) {
  return (
    <TouchableOpacity
      style={[st.chip, small && st.chipSmall, on && st.chipOn]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[st.chipText, on && st.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  cancel: { color: C.blue, fontSize: 15, fontWeight: '700', width: 56 },
  barTitle: { flex: 1, textAlign: 'center', fontSize: 15.5, fontWeight: '800', color: C.ink },

  vendor: { fontSize: 17, fontWeight: '800', color: C.ink, marginBottom: 14 },

  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, color: C.ink,
    backgroundColor: C.white, marginTop: 5,
  },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -3, marginTop: 5, marginBottom: 6 },
  chip: {
    paddingHorizontal: 13, paddingVertical: 9, margin: 3,
    borderRadius: 999, borderWidth: 1, borderColor: C.line, backgroundColor: C.white,
  },
  chipSmall: { paddingHorizontal: 11, paddingVertical: 7 },
  chipOn: { backgroundColor: C.ink, borderColor: C.ink },
  chipText: { fontSize: 13, fontWeight: '700', color: C.mute },
  chipTextOn: { color: C.white },

  check: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 16 },
  box: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: C.line,
    backgroundColor: C.white, marginRight: 10, alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: C.green, borderColor: C.green },
  tick: { color: C.white, fontSize: 14, fontWeight: '900' },
  checkLabel: { fontSize: 14.5, fontWeight: '700', color: C.ink },
  checkSub: { fontSize: 11.5, color: C.mute, lineHeight: 16, marginTop: 2 },

  hint: { fontSize: 11.5, color: C.mute, marginTop: 5, lineHeight: 16 },
  void: { marginTop: 16, alignItems: 'center', paddingVertical: 10 },
  voidText: { fontSize: 14, fontWeight: '700', color: C.red },

  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 11, marginBottom: 13,
  },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
});
