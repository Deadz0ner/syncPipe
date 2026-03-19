/**
 * mcSync Mobile App
 * Terminal-Driven Phone ↔ PC Sync Tool
 *
 * @format
 */

import React from 'react';
import {StatusBar} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import ErrorBoundary from './src/components/ErrorBoundary';
import HomeScreen from './src/screens/HomeScreen';
import PairScreen from './src/screens/PairScreen';
import FileTransferScreen from './src/screens/FileTransferScreen';
import SettingsScreen from './src/screens/SettingsScreen';

// Import FileTransferService at app root so its WebSocket handlers
// are registered immediately, regardless of which screen is active.
import './src/services/FileTransferService';

const Stack = createNativeStackNavigator();

function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#0D1117" />
        <NavigationContainer
        theme={{
          dark: true,
          fonts: {
            regular: {fontFamily: 'System', fontWeight: '400' as const},
            medium: {fontFamily: 'System', fontWeight: '500' as const},
            bold: {fontFamily: 'System', fontWeight: '700' as const},
            heavy: {fontFamily: 'System', fontWeight: '900' as const},
          },
          colors: {
            primary: '#1F6FEB',
            background: '#0D1117',
            card: '#161B22',
            text: '#E6EDF3',
            border: '#21262D',
            notification: '#238636',
          },
        }}>
        <Stack.Navigator
          initialRouteName="Home"
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
            contentStyle: {backgroundColor: '#0D1117'},
          }}>
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Pair" component={PairScreen} />
          <Stack.Screen name="FileTransfer" component={FileTransferScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

export default App;
