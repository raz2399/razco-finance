// Everything the app can do, on one page, because the home screen should
// stay the two or three things Raz does every day and not become a list of
// everything that exists.

import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, SafeAreaView, StyleSheet,
} from 'react-native';
import { C } from './theme';

const GROUPS = [
  {
    title: 'Every day',
    items: [
      { key: 'delivery', name: 'Record a delivery',
        sub: 'Photograph the invoices, stack them, save together' },
      { key: 'sales', name: 'Sales',
        sub: 'By tender, by department, by cashier' },
    ],
  },
  {
    title: 'Money out',
    items: [
      { key: 'checks', name: 'Checks still out',
        sub: 'Written but not cashed yet' },
      { key: 'vendors', name: 'Vendors',
        sub: 'Search one, see every invoice and check against him' },
    ],
  },
  {
    title: 'When something is wrong',
    items: [
      { key: 'fix', name: 'Fix a number',
        sub: 'Count the drawer, correct the bank, and say why' },
    ],
  },
  {
    title: 'This phone',
    items: [
      { key: 'signout', name: 'Sign out',
        sub: 'Ends the session here and on the server' },
    ],
  },
];

export default function MenuScreen({ onPick, onBack }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.bar}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={st.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={st.barTitle}>Menu</Text>
        <View style={{ width: 52 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
        {GROUPS.map((g) => (
          <View key={g.title} style={{ marginBottom: 16 }}>
            <Text style={st.group}>{g.title}</Text>
            <View style={st.card}>
              {g.items.map((it, i) => (
                <TouchableOpacity
                  key={it.key}
                  style={[st.row, i === g.items.length - 1 && st.rowLast]}
                  onPress={() => onPick(it.key)}
                  activeOpacity={0.6}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={st.name}>{it.name}</Text>
                    <Text style={st.sub}>{it.sub}</Text>
                  </View>
                  <Text style={st.chev}>›</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  back: { color: C.blue, fontSize: 15, fontWeight: '700', width: 52 },
  barTitle: { fontSize: 15.5, fontWeight: '800', color: C.ink },

  group: {
    fontSize: 10.5, fontWeight: '800', letterSpacing: 0.9, color: C.mute,
    textTransform: 'uppercase', marginBottom: 7, marginLeft: 3,
  },
  card: {
    backgroundColor: C.white, borderRadius: 14,
    borderWidth: 1, borderColor: C.line, overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 15,
    borderBottomWidth: 1, borderBottomColor: '#f1f3f7',
  },
  rowLast: { borderBottomWidth: 0 },
  name: { fontSize: 15, fontWeight: '700', color: C.ink },
  sub: { fontSize: 11.5, color: C.mute, marginTop: 2, lineHeight: 16 },
  chev: { fontSize: 22, color: '#c3cad6', marginLeft: 10 },
});
