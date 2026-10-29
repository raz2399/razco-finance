// Who Razco buys from, what is owed, and every line behind it.
//
// Two screens in one. Search finds the vendor; tapping the vendor opens his
// ledger. The ledger shows LINES -- this invoice on that day, that check on
// this day -- not a total. A total is what QuickBooks gives and it is no use
// when the question is "which invoice is this".
//
// The sort chips change the order of the lines. What they never change is
// the balance on each line: that is the balance as of that line's own date,
// worked out on the server in date order before any sorting happens. Sort by
// amount and add the column up in your head and you would get a number that
// means nothing -- so the number shown is never that.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, RefreshControl, ActivityIndicator,
  TouchableOpacity, SafeAreaView, StyleSheet,
} from 'react-native';
import {
  findVendors, getVendorLedger, money, todayPacific,
  settleInvoices, unsettleInvoices, settleWholeVendor, payWholeVendor,
} from './api';
import VendorLineSheet from './VendorLineSheet';
import Confirm from './Confirm';
import Notice from './Notice';
import { C, S } from './theme';

const METHOD_NOTE = {
  COD: 'check at the door',
  'COD draft': 'bank takes it next day',
  'Auto-draft': 'bank takes it on the due date',
  Charge: 'we write a check on terms',
  Check: 'we write a check on terms',
};

const SORTS = [
  { key: 'date', label: 'Date' },
  { key: 'number', label: 'Number' },
  { key: 'entered', label: 'Entered' },
  { key: 'amount', label: 'Amount' },
];

// The day the line is dated, short. Dates arrive as plain YYYY-MM-DD, which
// is not an instant, so it is read apart rather than handed to Date -- a
// date string parsed as UTC comes back a day early in California.
function shortDate(ymd) {
  if (!ymd) return '';
  const p = String(ymd).split('-');
  if (p.length !== 3) return String(ymd);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (MON[Number(p[1]) - 1] || p[1]) + ' ' + Number(p[2]);
}

// The moment it was keyed in, in Lindsay time. This is a real instant, so it
// is converted properly.
function enteredAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).replace(' AM', 'am').replace(' PM', 'pm');
  } catch (e) {
    return String(iso).slice(0, 10);
  }
}

export default function VendorsScreen({ onBack }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [listError, setListError] = useState(null);
  const [searching, setSearching] = useState(true);

  const [vendorId, setVendorId] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [ledgerError, setLedgerError] = useState(null);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [sort, setSort] = useState('date');
  const [dir, setDir] = useState('desc');
  const [openOnly, setOpenOnly] = useState(false);

  // The add/fix sheet. editing is null when adding.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [working, setWorking] = useState(false);
  // The question on screen, and what to run if he says yes.
  const [ask, setAsk] = useState(null);
  const [notice, setNotice] = useState(null);

  // Typing shouldn't fire a request per keystroke. A short pause does.
  useEffect(() => {
    let dead = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await findVendors(q.trim());
        if (!dead) { setList(r); setListError(null); }
      } catch (e) {
        if (!dead) setListError(e.message);
      } finally {
        if (!dead) setSearching(false);
      }
    }, q ? 280 : 0);
    return () => { dead = true; clearTimeout(t); };
  }, [q]);

  const loadLedger = useCallback(async (id, s, d, open, isRefresh) => {
    if (!id) return;
    isRefresh ? setRefreshing(true) : setLoadingLedger(true);
    try {
      const r = await getVendorLedger(id, s, d, open);
      setLedger(r);
      setLedgerError(null);
    } catch (e) {
      setLedgerError(e.message);
    } finally {
      setLoadingLedger(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (vendorId) loadLedger(vendorId, sort, dir, openOnly);
  }, [vendorId, sort, dir, openOnly, loadLedger]);

  const openVendor = (id) => { setLedger(null); setVendorId(id); };
  const backToList = () => { setVendorId(null); setLedger(null); setLedgerError(null); };

  // After anything is written, the ledger is re-read rather than patched
  // in place -- the running balance is worked out on the server in date
  // order, and guessing at it here is how two screens start disagreeing.
  async function afterWrite(says) {
    setSheetOpen(false);
    setEditing(null);
    await loadLedger(vendorId, sort, dir, openOnly);
    if (says) setNotice({ bad: false, text: says });
  }

  // Ask, then do. The asking is a view this screen renders, not an OS
  // alert -- see Confirm.js for why that difference cost a working button.
  //
  // `run` takes whatever was typed into the confirm box, so the check
  // number comes through the same path as everything else rather than
  // through Alert.prompt, which does not exist on Android at all.
  function act(run, confirm) {
    if (confirm) { setAsk({ spec: confirm, run: run }); return; }
    go(run);
  }

  async function go(run, typed) {
    setAsk(null);
    setWorking(true);
    try {
      const r = await run(typed);
      await afterWrite(r && r.says);
    } catch (e) {
      // Shown on the screen, not through an alert that may never appear.
      setNotice({ bad: true, text: e.message });
    } finally {
      setWorking(false);
    }
  }

  function pickSort(key) {
    if (key === sort) { setDir(dir === 'asc' ? 'desc' : 'asc'); return; }
    setSort(key);
    setDir(key === 'date' || key === 'entered' ? 'desc' : 'asc');
  }

  // ---------------- one vendor's ledger ----------------

  if (vendorId) {
    const v = ledger && ledger.vendor;
    const t = (ledger && ledger.totals) || {};
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={st.bar}>
          <TouchableOpacity onPress={backToList} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={st.back} numberOfLines={1}>‹ Vendors</Text>
          </TouchableOpacity>
          <Text style={st.barTitle} numberOfLines={1}>
            {v ? v.name : 'Loading'}
          </Text>
          <View style={{ width: 84 }} />
        </View>

        {loadingLedger && !ledger ? (
          <View style={st.center}>
            <ActivityIndicator size="large" color={C.red} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 12, paddingBottom: 110 }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => loadLedger(vendorId, sort, dir, openOnly, true)}
                tintColor={C.red}
              />
            }
          >
            {ledgerError ? (
              <View style={st.errorBox}><Text style={st.errorText}>{ledgerError}</Text></View>
            ) : null}

            {ledger ? (
              <>
                <View style={S.card}>
                  <Text style={st.owedLabel}>Owed to {v.name}</Text>
                  <Text style={st.owed}>{money(t.owed, true)}</Text>
                  <Text style={st.owedSub}>
                    {v.method_label
                      ? v.method_label + (METHOD_NOTE[v.method_label] ? ' — ' + METHOD_NOTE[v.method_label] : '')
                      : 'Payment type never recorded'}
                    {v.terms ? '  ·  ' + v.terms : ''}
                  </Text>

                  <View style={st.tiles}>
                    <Tile label="Charged" value={money(t.charged)} />
                    <Tile label="Paid" value={money(t.paid)} />
                  </View>
                  {t.checks_not_cashed ? (
                    <Text style={st.flag}>
                      {t.checks_not_cashed} check{t.checks_not_cashed > 1 ? 's' : ''} written
                      but not cashed — {money(t.checks_not_cashed_total, true)}
                    </Text>
                  ) : null}
                  {t.from_quickbooks ? (
                    <Text style={st.qb}>
                      {money(t.from_quickbooks, true)} of that is the opening balance
                      carried over from QuickBooks, not an invoice anyone has seen.
                    </Text>
                  ) : null}
                </View>

                <View style={st.chipRow}>
                  {SORTS.map((s) => (
                    <TouchableOpacity
                      key={s.key}
                      style={[st.chip, sort === s.key && st.chipOn]}
                      onPress={() => pickSort(s.key)}
                      activeOpacity={0.7}
                    >
                      <Text style={[st.chipText, sort === s.key && st.chipTextOn]}>
                        {s.label}{sort === s.key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={[st.chip, openOnly && st.chipOn]}
                    onPress={() => setOpenOnly(!openOnly)}
                    activeOpacity={0.7}
                  >
                    <Text style={[st.chipText, openOnly && st.chipTextOn]}>Still open</Text>
                  </TouchableOpacity>
                </View>

                <View style={S.card}>
                  <Text style={S.label}>
                    {ledger.count} line{ledger.count === 1 ? '' : 's'}
                  </Text>
                  {ledger.entries.map((e) => (
                    <Line
                      key={e.kind + e.id}
                      e={e}
                      busy={working}
                      onFix={() => { setEditing(e); setSheetOpen(true); }}
                      onPaid={() => act(
                        () => (e.paid_outside > 0
                          ? unsettleInvoices([e.id])
                          : settleInvoices([e.id])),
                        e.paid_outside > 0 ? null : {
                          title: 'Already paid?',
                          body: 'This clears the balance and writes NO check, '
                              + 'because the money did not leave through this '
                              + 'system. Use it for a bill settled in QuickBooks '
                              + 'or before the switchover.',
                          yes: 'Yes, clear it',
                        })}
                    />
                  ))}
                  {!ledger.entries.length ? (
                    <Text style={st.none}>
                      {openOnly ? 'Nothing still open for this vendor.' : 'Nothing on this vendor yet.'}
                    </Text>
                  ) : null}
                </View>

                {/* The two senses of paid, kept apart in the words.        */}
                {t.owed > 0 ? (
                  <View style={{ marginTop: 4 }}>
                    <TouchableOpacity
                      style={st.wide}
                      disabled={working}
                      activeOpacity={0.75}
                      onPress={() => act(() => settleWholeVendor(vendorId), {
                        title: 'Clear the whole vendor',
                        body: 'Marks everything still open as already paid '
                            + 'somewhere else. It clears ' + money(t.owed, true)
                            + ' and writes NO check. Each line can be put back '
                            + 'one at a time.',
                        yes: 'Clear it all',
                      })}
                    >
                      <Text style={st.wideText}>Already paid — clear {money(t.owed)}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[st.wide, st.wideStrong]}
                      disabled={working}
                      activeOpacity={0.75}
                      onPress={() => act(
                        (checkNumber) => payWholeVendor(
                          vendorId, 'check', checkNumber, todayPacific()),
                        {
                          title: 'Pay it all now',
                          body: 'Writes ONE check for ' + money(t.owed, true)
                              + ' and puts it against every open invoice. '
                              + 'This one does leave the bank.',
                          input: 'Check number',
                          numeric: true,
                          required: true,
                          yes: 'Write it',
                          danger: true,
                        })}
                    >
                      <Text style={[st.wideText, st.wideTextStrong]}>
                        Pay it now — write one check
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        )}

        {v ? (
          <TouchableOpacity
            style={st.fab}
            activeOpacity={0.85}
            onPress={() => { setEditing(null); setSheetOpen(true); }}
          >
            <Text style={st.fabText}>+  Add a line</Text>
          </TouchableOpacity>
        ) : null}

        <VendorLineSheet
          visible={sheetOpen}
          vendor={v}
          editing={editing}
          onClose={() => { setSheetOpen(false); setEditing(null); }}
          onSaved={afterWrite}
          onFailed={(text) => setNotice({ bad: true, text })}
        />

        <Notice notice={notice} onClose={() => setNotice(null)} />

        <Confirm
          ask={ask && ask.spec}
          busy={working}
          onNo={() => setAsk(null)}
          onYes={(typed) => go(ask.run, typed)}
        />
      </SafeAreaView>
    );
  }

  // ---------------- finding the vendor ----------------

  const vendors = (list && list.vendors) || [];
  const owing = vendors.filter((v) => v.owed !== 0);
  const clear = vendors.filter((v) => v.owed === 0);

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
          placeholder="Search a vendor"
          placeholderTextColor="#b6bcc8"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        {listError ? (
          <View style={st.errorBox}><Text style={st.errorText}>{listError}</Text></View>
        ) : null}

        {searching && !list ? (
          <View style={{ paddingTop: 40 }}>
            <ActivityIndicator size="large" color={C.red} />
          </View>
        ) : null}

        {list && !q.trim() ? (
          <Text style={st.totalLine}>
            {money(list.total_owed, true)} owed across {owing.length} vendor
            {owing.length === 1 ? '' : 's'}
          </Text>
        ) : null}

        {owing.length ? (
          <View style={S.card}>
            <Text style={S.label}>Money against them</Text>
            {owing.map((v) => <VendorRow key={v.vendor_id} v={v} onPress={openVendor} />)}
          </View>
        ) : null}

        {clear.length ? (
          <View style={S.card}>
            <Text style={S.label}>Nothing owed ({clear.length})</Text>
            {clear.map((v) => <VendorRow key={v.vendor_id} v={v} onPress={openVendor} />)}
          </View>
        ) : null}

        {list && !vendors.length ? (
          <View style={S.card}>
            <Text style={st.none}>
              {q.trim() ? 'No vendor matches “' + q.trim() + '”.' : 'No vendors on file yet.'}
            </Text>
          </View>
        ) : null}

        {list && list.truncated ? (
          <Text style={st.more}>
            Showing the first 60. Type a few letters of the name to narrow it.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({ label, value }) {
  return (
    <View style={st.tile}>
      <Text style={st.tileLabel}>{label}</Text>
      <Text style={st.tileValue}>{value}</Text>
    </View>
  );
}

function VendorRow({ v, onPress }) {
  // Name and money, and nothing else unless it earns its line.
  //
  // It used to print the payment type, the terms, the open count and the
  // other spellings of the name under every single vendor -- four lines
  // apiece, two hundred and fifty-five times. All of it true and almost
  // none of it what he came to the screen for. The aliases in particular
  // are how the importer matches a name on paper; they are not something
  // anyone reads.
  const bits = [];
  if (!v.pay_method) bits.push('no payment type');
  if (v.open_count > 1) bits.push(v.open_count + ' open');

  return (
    <TouchableOpacity style={st.row} onPress={() => onPress(v.vendor_id)} activeOpacity={0.6}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={st.name} numberOfLines={1}>{v.name}</Text>
        {bits.length ? <Text style={st.sub}>{bits.join('  ·  ')}</Text> : null}
      </View>
      {v.owed ? <Text style={st.rowOwed}>{money(v.owed)}</Text> : null}
      <Text style={st.chev}>›</Text>
    </TouchableOpacity>
  );
}

function Line({ e, onFix, onPaid, busy }) {
  const isPay = e.kind === 'payment';
  const dead = !!e.voided;
  // Settled with no payment here to account for it.
  const outside = !isPay && !dead && e.paid_outside > 0;

  return (
    <View style={st.line}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text
          style={[
            st.lineWhat,
            e.opening && { color: '#8D6E00' },
            dead && st.struck,
          ]}
          numberOfLines={1}
        >
          {e.opening ? 'Opening balance' : e.label}
        </Text>
        <Text style={st.lineMeta}>
          {shortDate(e.date)}
          {e.number ? '  ·  #' + e.number : ''}
          {e.due_date && !dead ? '  ·  due ' + shortDate(e.due_date) : ''}
          {isPay && !e.settled && !dead ? '  ·  not cashed' : ''}
          {outside ? '  ·  paid elsewhere' : ''}
          {dead ? '  ·  VOID' : ''}
        </Text>
        <Text style={st.lineEntered}>keyed in {enteredAt(e.entered_at)}</Text>

        {/* A voided line keeps no buttons: there is nothing left to do to
            it, and it moves no money either way. */}
        {!dead ? (
          <View style={st.lineActs}>
            <TouchableOpacity
              style={st.act}
              onPress={onFix}
              disabled={busy}
              activeOpacity={0.6}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={st.actText}>Fix</Text>
            </TouchableOpacity>
            {!isPay ? (
              <TouchableOpacity
                style={st.act}
                onPress={onPaid}
                disabled={busy}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[st.actText, !outside && { color: '#168a5a' }]}>
                  {outside ? 'Not paid' : 'Paid'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={{ alignItems: 'flex-end' }}>
        <Text
          style={[
            st.lineAmount,
            isPay && { color: '#168a5a' },
            dead && st.struck,
          ]}
        >
          {dead ? money(e.face_amount, true)
                : isPay ? '− ' + money(e.paid, true)
                : money(e.charge, true)}
        </Text>
        <Text style={st.lineBalance}>{money(e.balance_after, true)}</Text>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  // Wide enough for the word. At 70 it broke after 'Vendor'.
  back: { color: C.blue, fontSize: 15, fontWeight: '700', minWidth: 84 },
  barTitle: { flex: 1, textAlign: 'center', fontSize: 15.5, fontWeight: '800', color: C.ink },

  searchWrap: {
    paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  search: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.ink,
    backgroundColor: C.bg,
  },

  totalLine: {
    fontSize: 12.5, color: C.mute, marginBottom: 10, marginLeft: 3, fontWeight: '600',
  },
  more: { fontSize: 11.5, color: C.mute, textAlign: 'center', marginTop: 4 },

  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f3f7',
  },
  name: { fontSize: 14.5, fontWeight: '600', color: C.ink },
  sub: { fontSize: 11.5, color: C.mute, marginTop: 2 },
  alias: { fontSize: 10.5, color: '#9aa3b2', marginTop: 1, fontStyle: 'italic' },
  rowOwed: { fontSize: 15, fontWeight: '800', color: C.ink },
  chev: { fontSize: 20, color: '#c3cad6', marginLeft: 8 },

  owedLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: C.mute, textTransform: 'uppercase' },
  owed: { fontSize: 30, fontWeight: '800', color: C.ink, letterSpacing: -1, marginTop: 3 },
  owedSub: { fontSize: 12, color: C.mute, marginTop: 3 },

  tiles: { flexDirection: 'row', marginTop: 13, marginHorizontal: -4 },
  tile: {
    flex: 1, marginHorizontal: 4, padding: 10,
    backgroundColor: C.bg, borderRadius: 10,
  },
  tileLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.7, color: C.mute, textTransform: 'uppercase' },
  tileValue: { fontSize: 16, fontWeight: '800', color: C.ink, marginTop: 2 },

  flag: { fontSize: 11.5, color: '#bf7b0a', marginTop: 11, lineHeight: 16, fontWeight: '600' },
  qb: { fontSize: 11.5, color: C.mute, marginTop: 9, lineHeight: 16 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 11, marginHorizontal: -3 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, margin: 3,
    borderRadius: 999, borderWidth: 1, borderColor: C.line, backgroundColor: C.white,
  },
  chipOn: { backgroundColor: C.ink, borderColor: C.ink },
  chipText: { fontSize: 12.5, fontWeight: '700', color: C.mute },
  chipTextOn: { color: C.white },

  line: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#f1f3f7',
  },
  lineWhat: { fontSize: 13.5, fontWeight: '700', color: C.ink },
  lineMeta: { fontSize: 11.5, color: C.mute, marginTop: 2 },
  lineEntered: { fontSize: 10.5, color: '#9aa3b2', marginTop: 1 },
  lineAmount: { fontSize: 14.5, fontWeight: '800', color: C.ink },
  lineBalance: { fontSize: 11, color: C.mute, marginTop: 2 },

  struck: { textDecorationLine: 'line-through', color: C.mute },

  lineActs: { flexDirection: 'row', marginTop: 7 },
  act: {
    paddingHorizontal: 11, paddingVertical: 5, marginRight: 7,
    borderRadius: 999, borderWidth: 1, borderColor: C.line, backgroundColor: C.white,
  },
  actText: { fontSize: 11.5, fontWeight: '800', color: C.mute },

  wide: {
    borderWidth: 1, borderColor: C.line, backgroundColor: C.white,
    borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginBottom: 9,
  },
  wideStrong: { borderColor: C.red },
  wideText: { fontSize: 14, fontWeight: '800', color: C.ink },
  wideTextStrong: { color: C.red },

  fab: {
    position: 'absolute', right: 16, bottom: 22,
    backgroundColor: C.red, borderRadius: 999,
    paddingHorizontal: 20, paddingVertical: 14,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 }, elevation: 5,
  },
  fabText: { color: C.white, fontSize: 14.5, fontWeight: '800' },

  none: { fontSize: 13, color: C.mute, paddingVertical: 8 },

  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 11, marginBottom: 11,
  },
  errorText: { fontSize: 13, color: C.red, fontWeight: '700' },
});
