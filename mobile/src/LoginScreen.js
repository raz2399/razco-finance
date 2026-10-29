// Signing in on the phone.
//
// Before this, anyone who installed the app saw the bank position. The app
// asked nothing and the server asked nothing either.

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator,
  SafeAreaView, StyleSheet, KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { login } from './api';
import { C, S } from './theme';

export default function LoginScreen({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    if (!email.trim() || !password) {
      setError('Email and password, please.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await login(email, password);
      onSignedIn(session);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <KeyboardAvoidingView
        style={st.wrap}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={st.head}>
          <Image source={require('../assets/icon.png')} style={st.logo} />
          <Text style={st.title}>
            Razi-Nova <Text style={{ color: C.red }}>Finance</Text>
          </Text>
          <Text style={st.sub}>Razco Foods, Lindsay</Text>
        </View>

        {error ? (
          <View style={st.errorBox}><Text style={st.errorText}>{error}</Text></View>
        ) : null}

        <Text style={S.label}>Email</Text>
        <TextInput
          style={st.input}
          value={email}
          onChangeText={(v) => { setEmail(v); setError(null); }}
          placeholder="you@razcofoods.net"
          placeholderTextColor="#b6bcc8"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
        />

        <Text style={[S.label, { marginTop: 14 }]}>Password</Text>
        <TextInput
          style={st.input}
          value={password}
          onChangeText={(v) => { setPassword(v); setError(null); }}
          placeholder="••••••••"
          placeholderTextColor="#b6bcc8"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          onSubmitEditing={submit}
          returnKeyType="go"
        />

        <TouchableOpacity
          style={[S.big, { marginTop: 20 }, busy && { opacity: 0.5 }]}
          onPress={submit}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy
            ? <ActivityIndicator color={C.white} />
            : <Text style={S.bigText}>Sign in</Text>}
        </TouchableOpacity>

        <Text style={st.note}>
          You will be asked again after the app has been fully closed. The next
          build will remember you.
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  head: { alignItems: 'center', marginBottom: 28 },
  logo: { width: 54, height: 54, resizeMode: 'contain', marginBottom: 10 },
  title: { fontSize: 23, fontWeight: '800', color: C.ink, letterSpacing: -0.6 },
  sub: { fontSize: 12.5, color: C.mute, marginTop: 3 },

  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingHorizontal: 13, paddingVertical: 13, fontSize: 16, color: C.ink,
    backgroundColor: C.white, marginTop: 6,
  },
  note: {
    fontSize: 11.5, color: C.mute, textAlign: 'center',
    marginTop: 18, lineHeight: 17,
  },
  errorBox: {
    backgroundColor: '#fdf1f1', borderWidth: 1, borderColor: '#f3c9ca',
    borderRadius: 10, padding: 12, marginBottom: 16,
  },
  errorText: { fontSize: 13.5, color: C.red, fontWeight: '700' },
});
