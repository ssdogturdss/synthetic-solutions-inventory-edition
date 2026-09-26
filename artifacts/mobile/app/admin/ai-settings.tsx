import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useGetAiConfig, useUpdateAiConfig, useTestAiConfig, AiConfigInputProvider } from '@workspace/api-client-react';
import { LoadingState } from '@/components/LoadingState';
import * as Haptics from 'expo-haptics';

const PROVIDERS: { value: AiConfigInputProvider; label: string; icon: 'cpu' | 'zap' }[] = [
  { value: AiConfigInputProvider.openai, label: 'OpenAI', icon: 'cpu' },
  { value: AiConfigInputProvider.grok, label: 'Grok (xAI)', icon: 'zap' },
];

type TestStatus =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success'; label: string }
  | { state: 'error'; message: string };

export default function AiSettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const { data: config, isLoading, refetch } = useGetAiConfig();
  const { mutateAsync: updateConfig, isPending: saving } = useUpdateAiConfig();
  const { mutateAsync: testConfig, isPending: testing } = useTestAiConfig();

  const [provider, setProvider] = useState<AiConfigInputProvider>(AiConfigInputProvider.openai);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>({ state: 'idle' });

  useEffect(() => {
    if (config) {
      // Map AiConfigProvider → AiConfigInputProvider (same values: openai/grok)
      const p = config.provider as unknown as AiConfigInputProvider;
      if (Object.values(AiConfigInputProvider).includes(p)) {
        setProvider(p);
      }
      setSystemPrompt(config.systemPrompt ?? '');
      setApiKey(''); // never pre-fill for security
    }
  }, [config]);

  // Reset test status when key or provider changes
  useEffect(() => {
    setTestStatus({ state: 'idle' });
  }, [apiKey, provider]);

  const handleTest = async () => {
    if (!apiKey.trim() && !config?.hasApiKey) {
      Alert.alert('No key to test', 'Enter an API key to test the connection.');
      return;
    }
    setTestStatus({ state: 'testing' });
    try {
      const result = await testConfig({
        data: {
          provider,
          ...(apiKey.trim() ? { apiKey } : {}),
        },
      });
      if (result.ok) {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setTestStatus({ state: 'success', label: result.provider ?? provider });
      } else {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setTestStatus({ state: 'error', message: result.error ?? 'Connection failed' });
      }
    } catch {
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setTestStatus({ state: 'error', message: 'Could not reach the server — check your network.' });
    }
  };

  const handleSave = async () => {
    if (!apiKey.trim() && !config?.hasApiKey) {
      Alert.alert('API Key required', 'Enter your AI provider API key.');
      return;
    }
    try {
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await updateConfig({
        data: {
          provider,
          systemPrompt: systemPrompt || undefined,
          ...(apiKey.trim() ? { apiKey } : {}),
        },
      });
      Alert.alert('Saved', 'AI settings updated successfully.');
      setApiKey('');
      setTestStatus({ state: 'idle' });
      refetch();
    } catch {
      Alert.alert('Error', 'Failed to save AI settings.');
    }
  };

  const handleResetPrompt = async () => {
    try {
      const updated = await updateConfig({
        data: {
          systemPrompt: '',
        },
      });
      setSystemPrompt(updated.systemPrompt ?? config?.systemPrompt ?? '');
      await refetch();
    } catch {
      Alert.alert('Error', 'Failed to reset the system prompt.');
    }
  };

  if (isLoading) return <LoadingState />;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
      keyboardShouldPersistTaps="handled"
    >
      {/* Status card */}
      <View style={[styles.statusCard, {
        backgroundColor: config?.hasApiKey ? colors.success + '18' : colors.warning + '18',
        borderColor: config?.hasApiKey ? colors.success + '40' : colors.warning + '40',
      }]}>
        <Feather name={config?.hasApiKey ? 'check-circle' : 'alert-circle'} size={18} color={config?.hasApiKey ? colors.success : colors.warning} />
        <Text style={[styles.statusText, { color: config?.hasApiKey ? colors.success : colors.warning, fontFamily: 'Inter_600SemiBold' }]}>
          {config?.hasApiKey
            ? `AI configured · ${config.provider}`
            : 'AI not configured — enter a key below'}
        </Text>
      </View>

      {/* Provider */}
      <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>PROVIDER</Text>
      <View style={styles.providerRow}>
        {PROVIDERS.map((p) => (
          <Pressable
            key={p.value}
            style={[styles.providerBtn, {
              borderColor: provider === p.value ? colors.primary : colors.border,
              backgroundColor: provider === p.value ? colors.primary + '18' : colors.card,
            }]}
            onPress={() => setProvider(p.value)}
          >
            <Feather name={p.icon} size={18} color={provider === p.value ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.providerText, {
              color: provider === p.value ? colors.primary : colors.foreground,
              fontFamily: provider === p.value ? 'Inter_600SemiBold' : 'Inter_400Regular',
            }]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* System Prompt */}
      <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>SYSTEM PROMPT</Text>
      <TextInput
        style={[styles.textarea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
        value={systemPrompt}
        onChangeText={setSystemPrompt}
        placeholderTextColor={colors.mutedForeground}
        multiline
        numberOfLines={12}
        textAlignVertical="top"
      />
      <Pressable
        style={({ pressed }) => [
          styles.resetPromptBtn,
          { borderColor: colors.border, backgroundColor: colors.card },
          pressed && { opacity: 0.8 },
          saving && { opacity: 0.7 },
        ]}
        onPress={handleResetPrompt}
        disabled={saving}
        testID="reset-system-prompt"
      >
        <Feather name="rotate-ccw" size={15} color={colors.mutedForeground} />
        <Text style={[styles.resetPromptText, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
          Reset to default
        </Text>
      </Pressable>

      {/* API Key */}
      <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>API KEY</Text>
      {config?.hasApiKey && (
        <View style={[styles.existingKeyNote, { backgroundColor: colors.success + '12', borderColor: colors.success + '30' }]}>
          <Feather name="lock" size={14} color={colors.success} />
          <Text style={[styles.existingKeyText, { color: colors.success, fontFamily: 'Inter_400Regular' }]}>
            Key is set. Leave blank to keep existing, or enter a new value to replace.
          </Text>
        </View>
      )}
      <View style={[styles.keyInput, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name="key" size={16} color={colors.mutedForeground} />
        <TextInput
          style={[styles.keyTextInput, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={config?.hasApiKey
            ? 'Enter new key to replace…'
            : provider === AiConfigInputProvider.openai ? 'sk-…' : 'xai-…'}
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry={!showKey}
          autoCorrect={false}
          autoCapitalize="none"
        />
        <Pressable onPress={() => setShowKey(!showKey)}>
          <Feather name={showKey ? 'eye-off' : 'eye'} size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* Test connection button */}
      <Pressable
        style={({ pressed }) => [
          styles.testBtn,
          {
            borderColor: testStatus.state === 'success'
              ? colors.success
              : testStatus.state === 'error'
                ? colors.destructive
                : colors.border,
            backgroundColor: testStatus.state === 'success'
              ? colors.success + '12'
              : testStatus.state === 'error'
                ? colors.destructive + '12'
                : colors.card,
          },
          pressed && { opacity: 0.8 },
          testing && { opacity: 0.7 },
        ]}
        onPress={handleTest}
        disabled={testing || saving}
      >
        {testing ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : (
          <Feather
            name={
              testStatus.state === 'success' ? 'check-circle' :
              testStatus.state === 'error' ? 'x-circle' : 'wifi'
            }
            size={16}
            color={
              testStatus.state === 'success' ? colors.success :
              testStatus.state === 'error' ? colors.destructive :
              colors.mutedForeground
            }
          />
        )}
        <Text style={[
          styles.testBtnText,
          {
            fontFamily: 'Inter_500Medium',
            color: testStatus.state === 'success'
              ? colors.success
              : testStatus.state === 'error'
                ? colors.destructive
                : colors.mutedForeground,
          },
        ]}>
          {testing
            ? 'Testing…'
            : testStatus.state === 'success'
              ? `Connected to ${testStatus.label}`
              : testStatus.state === 'error'
                ? testStatus.message
                : 'Test connection'}
        </Text>
      </Pressable>

      {/* Security note */}
      <View style={[styles.info, { backgroundColor: colors.muted, borderRadius: 12 }]}>
        <Text style={[styles.infoText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          Your API key is encrypted with AES-256-GCM and stored securely. It is never returned to clients.
        </Text>
      </View>

      <Pressable
        style={({ pressed }) => [styles.saveBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }, saving && { opacity: 0.7 }]}
        onPress={handleSave}
        disabled={saving}
      >
        <Feather name="save" size={18} color="#fff" />
        <Text style={[styles.saveBtnText, { fontFamily: 'Inter_700Bold' }]}>{saving ? 'Saving…' : 'Save AI Settings'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 20 },
  statusCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 24 },
  statusText: { flex: 1, fontSize: 14 },
  label: { fontSize: 12, letterSpacing: 0.6, marginBottom: 10 },
  providerRow: { flexDirection: 'row', gap: 10 },
  providerBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, borderWidth: 1, padding: 16 },
  providerText: { fontSize: 15 },
  textarea: { borderRadius: 12, borderWidth: 1, padding: 14, fontSize: 14, minHeight: 240 },
  resetPromptBtn: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  resetPromptText: { fontSize: 13 },
  existingKeyNote: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 10 },
  existingKeyText: { flex: 1, fontSize: 13 },
  keyInput: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 12 },
  keyTextInput: { flex: 1, fontSize: 15 },
  testBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 16 },
  testBtnText: { fontSize: 14, flexShrink: 1 },
  info: { padding: 14, marginBottom: 20 },
  infoText: { fontSize: 13, lineHeight: 18 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 14, padding: 18 },
  saveBtnText: { color: '#fff', fontSize: 17 },
});
