// Razi-Nova Finance.
//
// Home stays the two or three things Raz does every day: see where the money
// stands, record a delivery, look at the day's sales. Everything else lives
// behind Menu, so the screen he opens twenty times a day does not slowly
// turn into a list of everything the app can do.

import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  View, Text, Image, StyleSheet, SafeAreaView, TouchableOpacity,
} from 'react-native';
import HomeScreen from './src/HomeScreen';
import DeliveryScreen from './src/DeliveryScreen';
import SalesScreen from './src/SalesScreen';
import MenuScreen from './src/MenuScreen';
import FixScreen from './src/FixScreen';
import ChecksScreen from './src/ChecksScreen';
import VendorsScreen from './src/VendorsScreen';
import { C } from './src/theme';

export default function App() {
  const [screen, setScreen] = useState('home');
  // Bumping this forces Home to refetch, so the numbers move the moment an
  // invoice lands or a figure is corrected.
  const [version, setVersion] = useState(0);
  const refreshHome = () => setVersion((v) => v + 1);
  const home = () => setScreen('home');

  if (screen === 'menu') {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="dark" />
        <MenuScreen onBack={home} onPick={(k) => setScreen(k)} />
      </View>
    );
  }

  if (screen === 'sales') {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="dark" />
        <SalesScreen onBack={home} />
      </View>
    );
  }

  if (screen === 'checks') {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="dark" />
        <ChecksScreen onBack={home} />
      </View>
    );
  }

  if (screen === 'vendors') {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="dark" />
        <VendorsScreen onBack={home} />
      </View>
    );
  }

  if (screen === 'fix') {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="dark" />
        {/* Correcting a figure changes the headline number, so Home is told
            to refetch on the way out rather than showing the old one. */}
        <FixScreen onBack={() => { refreshHome(); home(); }} />
      </View>
    );
  }

  if (screen === 'delivery') {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="dark" />
        <DeliveryScreen
          onCancel={home}
          onDone={() => { refreshHome(); home(); }}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="dark" />
      <SafeAreaView style={{ backgroundColor: C.white }}>
        <View style={st.header}>
          <Image source={require('./assets/icon.png')} style={st.logo} />
          <Text style={st.title}>
            Razi-Nova <Text style={{ color: C.red }}>Finance</Text>
          </Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={st.menuBtn}
            onPress={() => setScreen('menu')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={st.menuText}>Menu</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
      <HomeScreen
        key={version}
        onRecordDelivery={() => setScreen('delivery')}
        onOpenSales={() => setScreen('sales')}
        onOpenChecks={() => setScreen('checks')}
        onFixNumbers={() => setScreen('fix')}
      />
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
  menuBtn: {
    paddingHorizontal: 13, paddingVertical: 7,
    borderRadius: 8, borderWidth: 1, borderColor: C.line,
  },
  menuText: { fontSize: 13.5, fontWeight: '700', color: C.blue },
});
