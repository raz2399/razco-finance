// Writing one check against bills he picked himself.
//
// ---------------------------------------------------------------------
// Why this screen earns its place
//
// Until now there were two ways to pay a vendor and neither was the one
// he actually wanted. "Pay the whole vendor" settles everything open,
// which is wrong the moment one invoice is in dispute or he is paying
// what he can this week. "Log a check" records a number and an amount
// with nothing underneath it, so the money comes off the balance but
// no invoice is ever marked paid.
//
// What was missing is the obvious thing: show me what this vendor is
// owed for, let me tick the ones I am paying, and write that check.
//
// ---------------------------------------------------------------------
// The quieter reason
//
// Twenty-one payments are sitting in "whose check was this?" and almost
// all of them are checks he wrote by hand. The bank sees them clear and
// has no idea who they were to, so they come off nothing he owes and
// the figure on the screen stays too high.
//
// That queue only stops growing if writing a check by hand is as easy
// here as it is at the counter. So this screen takes the number as he
// writes it, against the exact invoices it pays, and that check never
// becomes a mystery.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, ScrollView,
  SafeAreaView, StyleSheet, RefreshControl,
} from 'react-native';
import {
  findVendors, getVendorLedger, payChosenInvoices, money, todayPacific,
} from './api';
import Confirm from './Confirm';
import Notice from './Notice';
import { C, S } from './theme';

const shortDate = (d) => {
  if (!d) return '';
  const p = String(d).split('-');
  return p.length === 3 ? p[1] + '/' + p[2] : String(d);
};

const daysBetween = (a, b) => Math.round(
  (new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000
);

export default function WriteCheckScreen({ onBack, onDone }) {
  const [query, setQuery] = useState('');
  const [vendors, setVendors] = useState([]);
  const [searching, setSearching] = useState(false);

  const [vendor, setVendor] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [picked, setPicked] = useState({});
  const [byHand, setByHand] = useState(false);
  const [checkNo, setCheckNo] = useState('');
  const [date, setDate] = useState(todayPacific());

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [ask, setAsk] = useState(null);
  const [done, setDone] = useState(null);

  // ---- finding the vendor ---------------------------------------------
  const search = useCallback(async (q) => {
    setSearching(true);
    try {
      const r = await findVendors(q);
      setVendors((r && r.vendors) || []);
    } catch (e) {
      setNotice({ bad: true, text: e.message });
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => { search(''); }, [search]);

  // ---- what that vendor is owed for ------------------------------------
  const load = useCallback(async (vendorId) => {
    setLoading(true);
    try {
      // Only what is still open. A paid invoice on this screen is a
      // line he has to read and then skip.
      const r = await getVendorLedger(vendorId, 'date', 'asc', true);
      setLines((r && r.entries) || []);
      setVendor(r && r.vendor ? r.vendor : null);
      setPicked({});
    } catch (e) {
      setNotice({ bad: true, text: e.message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  function openVendor(v) {
    setDone(null);
    load(v.vendor_id);
  }

  const open = lines.filter((e) => e.kind === 'invoice' && !e.voided
    && Number(e.balance_due) > 0);

  const chosen = open.filter((e) => picked[e.id]);
  const total = chosen.reduce((s, e) => s + Number(e.balance_due || 0), 0);

  const today = todayPacific();
  const overdue = open.filter((e) => e.due_date && e.due_date < today);

  function toggle(id) {
    setPicked((p) => {
      const next = Object.assign({}, p);
      if (next[id]) delete next[id]; else next[id] = true;
      return next;
    });
  }

  function pickAll() {
    if (chosen.length === open.length) { setPicked({}); return; }
    const all = {};
    open.forEach((e) => { all[e.id] = true; });
    setPicked(all);
  }

  function pickOverdue() {
    const o = {};
    overdue.forEach((e) => { o[e.id] = true; });
    setPicked(o);
  }

  // ---- writing it -------------------------------------------------------
  async function write(allowDuplicate) {
    if (!chosen.length) return;
    if (byHand && !String(checkNo).trim()) {
      setNotice({ bad: true, text: 'Put in the number printed on the check you wrote.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const r = await payChosenInvoices(
        chosen.map((e) => e.id),
        byHand ? String(checkNo).trim() : null,
        date,
        allowDuplicate
      );
      setDone({
        amount: total,
        count: chosen.length,
        check_number: byHand ? String(checkNo).trim() : null,
        vendor: vendor ? vendor.name : '',
        result: r,
      });
      setPicked({});
      setCheckNo('');
      if (vendor) load(vendor.vendor_id);
      if (onDone) onDone();
    } catch (e) {
      // A number already spent is worth stopping over rather than
      // quietly writing a second check carrying it.
      if (e.data && e.data.duplicate_of) {
        setAsk({
          spec: {
            title: 'That number is already used',
            body: e.message + '\n\nWrite it anyway?',
          },
          run: () => write(true),
        });
      } else {
        setNotice({ bad: true, text: e.message });
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- after ------------------------------------------------------------
  if (done) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={st.bar}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={st.back}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={st.barTitle}>Written</Text>
          <View style={{ width: 56 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Text style={st.doneBig}>{money(done.amount)}</Text>
          <Text style={st.doneSub}>
            to {done.vendor} — {done.count} invoice{done.count === 1 ? '' : 's'} marked paid.
          </Text>
          <Text style={st.hint}>
            {done.check_number
              ? 'Check #' + done.check_number + ' is on the books. It clears itself '
                + 'off when the bank takes it.'
              : 'No number yet. It is waiting in Print checks, which gives it the '
                + 'number off the pad actually in the printer.'}
          </Text>
          <TouchableOpacity
            style={[S.big, { marginTop: 16 }]}
            onPress={() => { setDone(null); }}
            activeOpacity={0.85}
          >
            <Text style={S.bigText}>Write another</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- picking the vendor ----------------------------------------------
  if (!vendor) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={st.bar}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={st.back}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={st.barTitle}>Write a check</Text>
          <View style={{ width: 56 }} />
        </View>

        <View style={{ padding: 16, paddingBottom: 6 }}>
          <TextInput
            style={st.search}
            value={query}
            onChangeText={(t) => { setQuery(t); search(t); }}
            placeholder="Which vendor?"
            placeholderTextColor="#9aa3af"
            autoCorrect={false}
          />
        </View>

        {searching ? <ActivityIndicator color={C.red} style={{ marginTop: 20 }} /> : null}

        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
          {vendors.filter((v) => Number(v.owed) > 0).map((v) => (
            <TouchableOpacity
              key={v.vendor_id}
              style={st.vrow}
              onPress={() => openVendor(v)}
              activeOpacity={0.6}
            >
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={st.vname} numberOfLines={1}>{v.name}</Text>
                <Text style={st.vmeta}>
                  {v.open_count} open{v.method_label ? ' · ' + v.method_label : ''}
                </Text>
              </View>
              <Text style={st.vowed}>{money(v.owed)}</Text>
            </TouchableOpacity>
          ))}
          {!searching && !vendors.filter((v) => Number(v.owed) > 0).length ? (
            <Text style={st.empty}>
              Nobody with an open bill{query ? ' matching that' : ''}.
            </Text>
          ) : null}
        </ScrollView>

        <Notice notice={notice} onClose={() => setNotice(null)} />
      </SafeAreaView>
    );
  }

  // ---- picking the invoices ---------------------------------------------
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity
          onPress={() => { setVendor(null); setLines([]); setPicked({}); }}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={st.back}>‹ Vendors</Text>
        </TouchableOpacity>
        <Text style={st.barTitle} numberOfLines={1}>{vendor.name}</Text>
        <View style={{ width: 66 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 220 }}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(vendor.vendor_id); }}
            tintColor={C.red}
          />
        )}
      >
        {loading ? <ActivityIndicator color={C.red} /> : null}

        {!loading && !open.length ? (
          <Text style={st.empty}>Nothing open for {vendor.name}.</Text>
        ) : null}

        {open.length ? (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <TouchableOpacity style={st.chip} onPress={pickAll} activeOpacity={0.7}>
              <Text style={st.chipText}>
                {chosen.length === open.length ? 'Clear' : 'All ' + open.length}
              </Text>
            </TouchableOpacity>
            {overdue.length ? (
              <TouchableOpacity style={st.chip} onPress={pickOverdue} activeOpacity={0.7}>
                <Text style={st.chipText}>Past due ({overdue.length})</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {open.map((e) => {
          const on = !!picked[e.id];
          const late = e.due_date && e.due_date < today;
          const days = e.due_date ? daysBetween(today, e.due_date) : null;
          return (
            <TouchableOpacity
              key={e.id}
              style={[st.line, on && st.lineOn]}
              onPress={() => toggle(e.id)}
              activeOpacity={0.7}
            >
              <View style={[st.box, on && st.boxOn]}>
                {on ? <Text style={st.tick}>✓</Text> : null}
              </View>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={st.lineWhat} numberOfLines={1}>
                  {e.number ? 'Invoice ' + e.number : 'Invoice'}
                </Text>
                <Text style={[st.lineMeta, late && { color: '#a12025', fontWeight: '700' }]}>
                  {shortDate(e.date)}
                  {e.due_date
                    ? (late
                      ? '  ·  past due ' + Math.abs(days) + 'd'
                      : '  ·  due in ' + days + 'd')
                    : ''}
                  {Number(e.paid_outside) > 0 ? '  ·  part paid elsewhere' : ''}
                </Text>
              </View>
              <Text style={st.lineAmt}>{money(e.balance_due)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* What the check comes to, and how it gets its number. */}
      {open.length ? (
        <View style={st.foot}>
          <View style={st.footRow}>
            <Text style={st.footLabel}>
              {chosen.length} of {open.length} selected
            </Text>
            <Text style={st.footTotal}>{money(total)}</Text>
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <TouchableOpacity
              style={[st.mode, !byHand && st.modeOn]}
              onPress={() => setByHand(false)}
              activeOpacity={0.7}
            >
              <Text style={[st.modeText, !byHand && st.modeTextOn]}>Print it</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.mode, byHand && st.modeOn]}
              onPress={() => setByHand(true)}
              activeOpacity={0.7}
            >
              <Text style={[st.modeText, byHand && st.modeTextOn]}>I wrote it by hand</Text>
            </TouchableOpacity>
          </View>

          {byHand ? (
            <TextInput
              style={st.numInput}
              value={checkNo}
              onChangeText={setCheckNo}
              keyboardType="number-pad"
              placeholder="Number printed on the check"
              placeholderTextColor="#9aa3af"
            />
          ) : null}

          <TouchableOpacity
            style={[S.big, (!chosen.length || busy) && { opacity: 0.45 }]}
            onPress={() => write(false)}
            disabled={!chosen.length || busy}
            activeOpacity={0.85}
          >
            <Text style={S.bigText}>
              {busy ? 'Writing…'
                : chosen.length
                  ? 'Write the check for ' + money(total)
                  : 'Pick what this check pays'}
            </Text>
          </TouchableOpacity>

          <Text style={st.footNote}>
            {byHand
              ? 'Goes down against these invoices with the number you wrote, so it '
                + 'never turns up later as a check nobody can place.'
              : 'Goes to Print checks, which takes the number off the pad in the printer.'}
          </Text>
        </View>
      ) : null}

      <Confirm
        ask={ask}
        onCancel={() => setAsk(null)}
        onGo={() => { const r = ask && ask.run; setAsk(null); if (r) r(); }}
      />
      <Notice notice={notice} onClose={() => setNotice(null)} />
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#e6e9ef',
  },
  back: { color: C.blue, fontSize: 17, fontWeight: '600' },
  barTitle: { fontSize: 17, fontWeight: '800', color: C.text, flex: 1, textAlign: 'center' },

  search: {
    borderWidth: 1, borderColor: '#d6dbe3', borderRadius: 11, backgroundColor: '#fff',
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: C.text,
  },

  vrow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
    borderRadius: 11, padding: 14, marginBottom: 8,
  },
  vname: { fontSize: 16, fontWeight: '700', color: C.text },
  vmeta: { fontSize: 12.5, color: '#6b7484', marginTop: 2 },
  vowed: { fontSize: 16, fontWeight: '800', color: C.text },

  line: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
    borderRadius: 11, padding: 13, marginBottom: 8,
    borderWidth: 1.5, borderColor: 'transparent',
  },
  lineOn: { borderColor: C.red, backgroundColor: '#fff7f7' },
  box: {
    width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: '#c3c9d4',
    marginRight: 12, alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: C.red, borderColor: C.red },
  tick: { color: '#fff', fontSize: 15, fontWeight: '900' },
  lineWhat: { fontSize: 15, fontWeight: '700', color: C.text },
  lineMeta: { fontSize: 12.5, color: '#6b7484', marginTop: 2 },
  lineAmt: { fontSize: 15.5, fontWeight: '800', color: C.text },

  chip: {
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#d6dbe3',
  },
  chipText: { fontSize: 13, fontWeight: '700', color: C.text },

  foot: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#fff',
    borderTopWidth: 1, borderTopColor: '#e6e9ef', padding: 16, paddingBottom: 26,
  },
  footRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  footLabel: { fontSize: 13.5, color: '#6b7484', fontWeight: '600' },
  footTotal: { fontSize: 22, fontWeight: '900', color: C.text },
  footNote: { fontSize: 12, color: '#6b7484', marginTop: 9, lineHeight: 17 },

  mode: {
    flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center',
    backgroundColor: '#f2f4f8', borderWidth: 1, borderColor: '#e0e4ea',
  },
  modeOn: { backgroundColor: '#fff', borderColor: C.red },
  modeText: { fontSize: 13.5, fontWeight: '700', color: '#6b7484' },
  modeTextOn: { color: C.red },

  numInput: {
    borderWidth: 1, borderColor: '#d6dbe3', borderRadius: 9, backgroundColor: '#fff',
    paddingHorizontal: 13, paddingVertical: 12, fontSize: 16, color: C.text,
    marginBottom: 10,
  },

  empty: { fontSize: 14.5, color: '#6b7484', textAlign: 'center', marginTop: 28, lineHeight: 21 },
  hint: { fontSize: 13, color: '#6b7484', marginTop: 10, lineHeight: 19 },
  doneBig: { fontSize: 34, fontWeight: '900', color: C.text },
  doneSub: { fontSize: 15, color: C.text, marginTop: 4 },
});
