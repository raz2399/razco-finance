// Asking before doing something, in a way that cannot fail to appear.
//
// This replaces Alert.alert used as control flow. That pattern looked
// fine and had one failure mode that is worse than a crash:
//
//   const go = await new Promise((resolve) => {
//     Alert.alert(title, body, [
//       { text: 'No',  onPress: () => resolve(false) },
//       { text: 'Yes', onPress: () => resolve(true)  },
//     ]);
//   });
//
// If the alert never presents -- and on iOS it does not when a Modal is
// still in the view hierarchy, which is exactly where this app calls it
// from -- neither onPress ever fires, the promise never settles, and the
// function simply stops. No error. No request. No message. The button
// does nothing at all, for ever, and nothing anywhere says why.
//
// That is what happened: six taps, six requests, all fine, and then on
// the next screen the Paid button fired nothing. The server logs showed
// no request because none was ever made.
//
// This is a plain view. It is rendered by the screen that owns it, so it
// appears because it is in the tree, not because the OS agreed to show
// it. It cannot be swallowed and it cannot hang.
//
// It also carries an optional input, because the other half of the same
// problem was Alert.prompt -- which is iOS-only and silently absent on
// Android.

import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator,
  StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { C } from './theme';

export default function Confirm({ ask, busy, onYes, onNo }) {
  const [value, setValue] = useState('');

  // Reset the box each time a different question is asked, so yesterday's
  // check number is never sitting in today's field.
  useEffect(() => { setValue((ask && ask.initial) || ''); }, [ask]);

  if (!ask) return null;

  return (
    <View style={st.scrim}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={st.center}
      >
        <View style={st.card}>
          <Text style={st.title}>{ask.title}</Text>
          <Text style={st.body}>{ask.body}</Text>

          {ask.input ? (
            <>
              <Text style={st.label}>{ask.input}</Text>
              <TextInput
                style={st.input}
                value={value}
                onChangeText={setValue}
                keyboardType={ask.numeric ? 'number-pad' : 'default'}
                autoFocus
                autoCorrect={false}
              />
            </>
          ) : null}

          <View style={st.row}>
            <TouchableOpacity
              style={[st.btn, st.no]}
              onPress={onNo}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text style={st.noText}>{ask.no || 'No'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[st.btn, st.yes, ask.danger && st.danger, busy && { opacity: 0.6 }]}
              onPress={() => onYes(value)}
              disabled={busy || (ask.input && ask.required && !value.trim())}
              activeOpacity={0.8}
            >
              {busy
                ? <ActivityIndicator color={C.white} />
                : <Text style={st.yesText}>{ask.yes}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const st = StyleSheet.create({
  scrim: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(16,18,22,0.45)',
  },
  center: { flex: 1, justifyContent: 'center', paddingHorizontal: 22 },
  card: {
    backgroundColor: C.white, borderRadius: 16, padding: 20,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 }, elevation: 12,
  },
  title: { fontSize: 17, fontWeight: '800', color: C.ink },
  body: { fontSize: 13.5, color: C.mute, lineHeight: 19, marginTop: 8 },

  label: {
    fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, color: C.mute,
    textTransform: 'uppercase', marginTop: 16,
  },
  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 17, color: C.ink,
    backgroundColor: C.white, marginTop: 6,
  },

  row: { flexDirection: 'row', marginTop: 20 },
  btn: {
    flex: 1, paddingVertical: 13, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  no: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, marginRight: 8 },
  noText: { fontSize: 14.5, fontWeight: '700', color: C.mute },
  yes: { backgroundColor: C.ink, marginLeft: 8 },
  danger: { backgroundColor: C.red },
  yesText: { fontSize: 14.5, fontWeight: '800', color: C.white },
});
