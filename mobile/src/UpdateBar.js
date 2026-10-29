// A new version is downloaded and waiting.
//
// It only appears when he is signed in, because signed out the update puts
// itself on without asking. Signed in, applying it restarts the app and
// the session lives in memory, so it would put him back at the sign-in
// screen -- which is not something to do to a man without telling him.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { C } from './theme';

export default function UpdateBar({ onApply }) {
  return (
    <View style={st.bar}>
      <Text style={st.text}>A new version is ready.</Text>
      <TouchableOpacity
        onPress={onApply}
        style={st.btn}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        activeOpacity={0.7}
      >
        <Text style={st.btnText}>Use it now</Text>
      </TouchableOpacity>
    </View>
  );
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: '#eef4fc', borderBottomWidth: 1, borderBottomColor: '#d6e3f5',
  },
  text: { fontSize: 12.5, color: C.ink, fontWeight: '600' },
  btn: {
    paddingHorizontal: 11, paddingVertical: 5,
    borderRadius: 999, backgroundColor: C.blue,
  },
  btnText: { fontSize: 12, fontWeight: '800', color: C.white },
});
