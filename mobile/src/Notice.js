// What just happened, said on the screen.
//
// The companion to Confirm.js. Alert.alert was carrying the answers too --
// "Done", "That did not work" -- and an alert that does not present takes
// the answer with it. An action that silently succeeds is nearly as bad
// as one that silently fails: he taps Paid, nothing visibly changes, and
// he taps it again.
//
// This is a view. It appears because it is in the tree.

import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { C } from './theme';

export default function Notice({ notice, onClose }) {
  useEffect(() => {
    if (!notice) return undefined;
    // Good news goes on its own. Bad news waits to be dismissed, because
    // a figure that would not save is not something to miss while
    // looking at the till.
    if (notice.bad) return undefined;
    const t = setTimeout(onClose, 4200);
    return () => clearTimeout(t);
  }, [notice, onClose]);

  if (!notice) return null;

  return (
    <View style={[st.bar, notice.bad ? st.bad : st.good]}>
      <Text style={[st.text, notice.bad ? st.badText : st.goodText]}>
        {notice.text}
      </Text>
      <TouchableOpacity
        onPress={onClose}
        hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
      >
        <Text style={[st.x, notice.bad ? st.badText : st.goodText]}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const st = StyleSheet.create({
  bar: {
    position: 'absolute', left: 12, right: 12, bottom: 90,
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12,
    borderWidth: 1,
    shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 }, elevation: 8,
  },
  good: { backgroundColor: '#f1faf5', borderColor: '#bfe3d0' },
  bad: { backgroundColor: '#fdf1f1', borderColor: '#f3c9ca' },
  text: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  goodText: { color: '#13694a' },
  badText: { color: C.red },
  x: { fontSize: 14, fontWeight: '800', marginLeft: 12 },
});
