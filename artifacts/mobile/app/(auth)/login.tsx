import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  Alert, Platform, useColorScheme, KeyboardAvoidingView, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { PinKeypad, PinDots } from '@/components/PinKeypad';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login, biometricLogin, canUseBiometric } = useAuth();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<TextInput>(null);

  const handlePinChange = async (newPin: string) => {
    setPin(newPin);
    setError('');
    if (newPin.length >= 4 && name.trim()) {
      await handleLogin(newPin);
    }
  };

  const handleLogin = async (pinValue = pin) => {
    if (!name.trim()) { setError('Enter your name'); return; }
    if (pinValue.length < 4) { setError('PIN must be at least 4 digits'); return; }
    setIsLoading(true);
    setError('');
    try {
      await login({ name: name.trim(), pin: pinValue });
    } catch (e: any) {
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(e?.message?.includes('401') || e?.message?.includes('Invalid') ? 'Incorrect name or PIN' : 'Login failed. Try again.');
      setPin('');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBiometric = async () => {
    const ok = await biometricLogin();
    if (ok && name.trim()) {
      // Biometric confirms identity — still need stored PIN
      setError('Biometric verified — enter your PIN to continue');
    } else if (!name.trim()) {
      setError('Enter your name first');
    }
  };

  const gradientColors: [string, string] = isDark
    ? ['#0D1526', '#131E33']
    : ['#EEF2FF', '#FFFFFF'];

  return (
    <LinearGradient colors={gradientColors} style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.container, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={false}
        >
          {/* Logo / Header */}
          <View style={styles.header}>
            <Image
              source={require('@/assets/images/logo.jpeg')}
              style={styles.logoImage}
              resizeMode="contain"
            />
            <Text style={[styles.appSub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              Inventory Management
            </Text>
          </View>

          {/* Name field */}
          <View style={styles.section}>
            <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              Your Name
            </Text>
            <View style={[styles.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="user" size={16} color={colors.mutedForeground} />
              <TextInput
                ref={nameRef}
                style={[styles.input, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
                placeholder="Enter your name"
                placeholderTextColor={colors.mutedForeground}
                value={name}
                onChangeText={(t) => { setName(t); setError(''); }}
                autoCorrect={false}
                returnKeyType="done"
                testID="name-input"
              />
              {name.length > 0 && (
                <Pressable onPress={() => setName('')}>
                  <Feather name="x-circle" size={16} color={colors.mutedForeground} />
                </Pressable>
              )}
            </View>
          </View>

          {/* PIN Entry */}
          <View style={styles.section}>
            <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              PIN
            </Text>
            <PinDots value={pin} maxLength={6} color={colors.primary} />
          </View>

          {/* Error */}
          {error ? (
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + '18' }]}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive, fontFamily: 'Inter_400Regular' }]}>
                {error}
              </Text>
            </View>
          ) : null}

          {/* Keypad */}
          <PinKeypad
            value={pin}
            onChange={handlePinChange}
            maxLength={6}
            onBiometric={handleBiometric}
            showBiometric={canUseBiometric && !!name.trim() && Platform.OS !== 'web'}
          />

          {/* Sign In button when name ready but PIN not auto-submit */}
          {name.trim() && pin.length >= 4 && (
            <Pressable
              style={({ pressed }) => [styles.signInBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }, isLoading && { opacity: 0.7 }]}
              onPress={() => handleLogin()}
              disabled={isLoading}
            >
              <Text style={[styles.signInText, { fontFamily: 'Inter_700Bold' }]}>
                {isLoading ? 'Signing in…' : 'Sign In'}
              </Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: 24, paddingHorizontal: 16 },
  header: { alignItems: 'center', gap: 6, marginBottom: 8 },
  logoImage: { width: 240, height: 175 },
  appSub: { fontSize: 14, textAlign: 'center' },
  section: { width: '100%', gap: 10, alignItems: 'center' },
  label: { fontSize: 13, alignSelf: 'flex-start', marginLeft: 4 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 14,
    width: '100%',
  },
  input: { flex: 1, fontSize: 16 },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 8, padding: 12, width: '100%' },
  errorText: { fontSize: 13, flex: 1 },
  signInBtn: { width: '80%', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  signInText: { color: '#fff', fontSize: 17 },
});
