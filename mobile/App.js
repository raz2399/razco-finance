// Razi-Nova Finance.
// Two screens for now, both of them things Raz does every day: see where the
// money stands, and record a delivery before the invoice hits the pile.

import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, Text, Image, StyleSheet, SafeAreaView } from 'react-native';
import HomeScreen from './src/HomeScreen';
import DeliveryScreen from './src/DeliveryScreen';
import { C } from './src/theme';

export default function App() {
  const [screen, setScreen] = useState('home');
  // Bumping this forces Home to refetch after a delivery is saved, so the
  // numbers move the moment the invoice lands.
  const [version, setVersion] = useState(0);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="dark" />

      {screen === 'home' ? (
        <>
          <SafeAreaView style={{ backgroundColor: C.white }}>
            <View style={st.header}>
              <Image source={require('./assets/icon.png')} style={st.logo} />
              <Text style={st.title}>
                Razi-Nova <Text style={{ color: C.red }}>Finance</Text>
              </Text>
            </View>
          </SafeAreaView>
          <HomeScreen
            key={version}
            onRecordDelivery={() => setScreen('delivery')}
            onOpenChecks={() => {}}
          />
        </>
      ) : (
        <DeliveryScreen
          onCancel={() => setScreen('home')}
          onDone={() => { setVersion((v) => v + 1); setScreen('home'); }}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.white,
  },
  logo: { width: 30, height: 30, resizeMode: 'contain', marginRight: 9 },
  title: { fontSize: 17, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
});
