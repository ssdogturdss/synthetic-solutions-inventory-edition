import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, Pressable,
  Platform, ActivityIndicator, useColorScheme, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { useListStores, useGetAiConfig, useListInventorySessions } from '@workspace/api-client-react';
import * as Haptics from 'expo-haptics';
import AiReportView from '@/components/AiReportView';
import { API_BASE_URL } from '@/constants/api';

// ── Streaming chat fetch ──────────────────────────────────────────────────────
const BASE_URL = API_BASE_URL ? `${API_BASE_URL}/` : '/';

async function streamChat(
  messages: Array<{ role: string; content: string }>,
  storeId: number | null,
  token: string,
  onChunk: (partial: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = `${BASE_URL}api/ai/chat/stream`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages, storeId }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let msg = 'AI provider error';
    try { msg = (JSON.parse(text) as { error?: string }).error ?? msg; } catch { if (text) msg = text.slice(0, 200); }
    throw Object.assign(new Error(msg), { status: resp.status });
  }

  if (!resp.body) throw new Error('No response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload) as { chunk?: string; error?: string };
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.chunk) { full += parsed.chunk; onChunk(full); }
        } catch (e) { if ((e as Error).message !== payload) throw e; }
      }
    }
  } finally {
    reader.cancel();
  }
}

type AiMode = 'chat' | 'reports';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const RECENT_SESSION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export default function AiScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, token: authToken } = useAuth();
  const colorScheme = useColorScheme();
  const isAdmin = user?.role === 'admin';

  const [mode, setMode] = useState<AiMode>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [selectedStoreId, setSelectedStoreId] = useState<number | null>(user?.storeId ?? null);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [showStorePicker, setShowStorePicker] = useState(false);
  const [aiNotConfigured, setAiNotConfigured] = useState(false);

  // Retain the in-flight AbortController so we can cancel it on unmount or navigation.
  const abortCtrlRef = useRef<AbortController | null>(null);

  // Cancel any in-flight stream when the component unmounts (e.g., app background).
  useEffect(() => {
    return () => { abortCtrlRef.current?.abort(); };
  }, []);

  // Cancel when the user navigates away from this screen (tab switch, back nav, etc.).
  useFocusEffect(
    useCallback(() => {
      return () => { abortCtrlRef.current?.abort(); };
    }, []),
  );

  const { data: stores } = useListStores();
  const { data: aiConfig } = useGetAiConfig();
  const recentSessionsParams = selectedStoreId === null
    ? { status: 'finalized' as const, limit: 1 }
    : { storeId: selectedStoreId, status: 'finalized' as const, limit: 1 };
  const { data: finalizedSessions } = useListInventorySessions(
    recentSessionsParams,
    {
      query: {
        queryKey: ['/api/inventory-sessions', recentSessionsParams],
        enabled: mode === 'chat' && !!user,
        staleTime: 60_000,
      },
    },
  );

  const topPadding = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  const selectedStore = (stores ?? []).find((s) => s.id === selectedStoreId);
  const noRecentInventoryData =
    mode === 'chat' &&
    finalizedSessions !== undefined &&
    !finalizedSessions.some((session) => {
      if (!session.finalizedAt) return false;
      const finalizedAt = new Date(session.finalizedAt).getTime();
      return Number.isFinite(finalizedAt) && finalizedAt >= Date.now() - RECENT_SESSION_WINDOW_MS;
    });

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isThinking) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const userMsg: ChatMessage = { id: `${Date.now()}-u`, role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setIsThinking(true);
    setStreamingContent('');

    const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));
    // Cancel any previous in-flight request before starting a new one.
    abortCtrlRef.current?.abort();
    const abortCtrl = new AbortController();
    abortCtrlRef.current = abortCtrl;

    try {
      await streamChat(
        apiMessages,
        selectedStoreId,
        authToken ?? '',
        (partial) => setStreamingContent(partial),
        abortCtrl.signal,
      );
      // Commit the streamed message to history
      setMessages((prev) => {
        const finalContent = prev; // capture
        // streamingContent state is stale here; read from a ref-like approach below
        return finalContent;
      });
      // Flush streaming into messages using functional updater pattern
      setStreamingContent((finalText) => {
        if (finalText) {
          setMessages((prev) => [
            ...prev,
            { id: `${Date.now()}-a`, role: 'assistant', content: finalText },
          ]);
        }
        return null;
      });
      setAiNotConfigured(false);
    } catch (err: unknown) {
      setStreamingContent(null);
      // If the request was aborted by our own controller (e.g. user navigated
      // away or started a new chat), treat it as a silent cancellation —
      // remove the pending user message and don't show an error.
      if (abortCtrl.signal.aborted || (err as Error)?.name === 'AbortError') {
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        return;
      }
      const status = (err as { status?: number })?.status;
      if (status === 503) {
        setAiNotConfigured(true);
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      } else {
        const msg = (err as Error)?.message ?? 'Could not reach the AI assistant.';
        setMessages((prev) => [
          ...prev,
          { id: `${Date.now()}-e`, role: 'assistant', content: `Sorry — ${msg}` },
        ]);
      }
    } finally {
      setIsThinking(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, isThinking, messages, selectedStoreId, authToken]);

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.msgRow, isUser && styles.msgRowUser]}>
        {!isUser && (
          <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
            <Feather name="cpu" size={14} color="#fff" />
          </View>
        )}
        <View style={[
          styles.bubble,
          isUser
            ? { backgroundColor: colors.primary, borderBottomRightRadius: 4 }
            : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderBottomLeftRadius: 4 },
        ]}>
          <Text style={[styles.bubbleText, { color: isUser ? '#fff' : colors.foreground, fontFamily: 'Inter_400Regular' }]}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior={mode === 'chat' && Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 49 + insets.bottom : 0}
    >
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: topPadding + 12, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>AI</Text>
          {mode === 'chat' && isAdmin && (
            <Pressable onPress={() => setShowStorePicker(!showStorePicker)} style={styles.storeRow}>
              <Feather name="map-pin" size={12} color={colors.mutedForeground} />
              <Text style={[styles.storeText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {selectedStore?.name ?? 'All stores'} ▾
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.headerCenter}>
          {/* Segmented control */}
          <View style={[styles.segmentTrack, { backgroundColor: colors.muted }]}>
            <Pressable
              style={[styles.segmentBtn, mode === 'chat' && { backgroundColor: colors.background, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }]}
              onPress={() => setMode('chat')}
            >
              <Feather name="message-circle" size={14} color={mode === 'chat' ? colors.primary : colors.mutedForeground} />
              <Text style={[styles.segmentText, { color: mode === 'chat' ? colors.primary : colors.mutedForeground,
                fontFamily: mode === 'chat' ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>Chat</Text>
            </Pressable>
            <Pressable
              style={[styles.segmentBtn, mode === 'reports' && { backgroundColor: colors.background, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }]}
              onPress={() => setMode('reports')}
            >
              <Feather name="cpu" size={14} color={mode === 'reports' ? colors.primary : colors.mutedForeground} />
              <Text style={[styles.segmentText, { color: mode === 'reports' ? colors.primary : colors.mutedForeground,
                fontFamily: mode === 'reports' ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>Reports</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.headerActions}>
          {mode === 'chat' && (
            <>
              <Pressable
                style={({ pressed }) => [styles.iconBtn, { backgroundColor: colors.muted }, pressed && { opacity: 0.7 }]}
                onPress={() => setMessages([])}
              >
                <Feather name="refresh-cw" size={18} color={colors.foreground} />
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.iconBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.7 }]}
                onPress={() => router.push('/voice-call')}
              >
                <Feather name="phone" size={18} color="#fff" />
              </Pressable>
            </>
          )}
          {mode === 'reports' && (
            <Pressable
              style={({ pressed }) => [styles.iconBtn, { backgroundColor: colors.muted }, pressed && { opacity: 0.7 }]}
              onPress={() => router.push('/admin/ai-settings')}
            >
              <Feather name="settings" size={18} color={colors.foreground} />
            </Pressable>
          )}
        </View>
      </View>

      {/* ── Store picker ── */}
      {showStorePicker && isAdmin && mode === 'chat' && (
        <View style={[styles.storeDropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Pressable style={styles.storeOption} onPress={() => { setSelectedStoreId(null); setShowStorePicker(false); }}>
            <Text style={[styles.storeOptionText, { color: selectedStoreId === null ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>All stores</Text>
          </Pressable>
          {(stores ?? []).map((s) => (
            <Pressable key={s.id} style={styles.storeOption} onPress={() => { setSelectedStoreId(s.id); setShowStorePicker(false); }}>
              <Text style={[styles.storeOptionText, { color: selectedStoreId === s.id ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>
                {s.name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* ── AI not configured banner (chat mode) ── */}
      {mode === 'chat' && isAdmin && (aiConfig?.hasApiKey === false || aiNotConfigured) && (
        <Pressable
          style={[styles.configBanner, { backgroundColor: colors.warning + '18', borderColor: colors.warning + '50' }]}
          onPress={() => router.push('/admin/ai-settings')}
        >
          <Feather name="alert-circle" size={16} color={colors.warning} />
          <Text style={[styles.configBannerText, { color: colors.warning, fontFamily: 'Inter_600SemiBold' }]}>
            AI not configured — tap to set up
          </Text>
          <Feather name="chevron-right" size={16} color={colors.warning} />
        </Pressable>
      )}
      {mode === 'chat' && !isAdmin && aiNotConfigured && (
        <View style={[styles.configBanner, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Feather name="info" size={16} color={colors.mutedForeground} />
          <Text style={[styles.configBannerText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            AI assistant not yet enabled — ask your manager to activate it
          </Text>
        </View>
      )}

      {/* ── Reports mode ── */}
      {mode === 'reports' && (
        <AiReportView bottomPadding={bottomInset + 32} />
      )}

      {/* ── Chat mode ── */}
      {mode === 'chat' && (
        <>
          <FlatList
            data={[...messages].reverse()}
            keyExtractor={(m) => m.id}
            inverted
            renderItem={renderMessage}
            contentContainerStyle={styles.messageList}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={isThinking ? (
              <View style={styles.msgRow}>
                <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
                  <Feather name="cpu" size={14} color="#fff" />
                </View>
                <View style={[styles.bubble, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderBottomLeftRadius: 4 }]}>
                  {streamingContent ? (
                    <Text style={[styles.bubbleText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>
                      {streamingContent}
                      <Text style={{ color: colors.primary }}>▍</Text>
                    </Text>
                  ) : (
                    <View style={styles.typingRow}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={[styles.typingText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>Thinking…</Text>
                    </View>
                  )}
                </View>
              </View>
            ) : null}
            ListFooterComponent={messages.length === 0 ? (
              <View style={styles.emptyChat}>
                <View style={[styles.emptyIcon, { backgroundColor: colors.muted }]}>
                  <Feather name="message-circle" size={32} color={colors.primary} />
                </View>
                <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                  Inventory AI
                </Text>
                <Text style={[styles.emptySub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  Ask about inventory levels, usage trends, or request executive summaries
                </Text>
              </View>
            ) : null}
          />

          {noRecentInventoryData && (
            <Pressable
              testID="recent-data-warning"
              style={[styles.recentDataBanner, { backgroundColor: colors.warning + '18', borderColor: colors.warning + '50' }]}
              onPress={() => router.push('/inventory/new')}
            >
              <Feather name="alert-triangle" size={16} color={colors.warning} />
              <Text style={[styles.recentDataBannerText, { color: colors.warning, fontFamily: 'Inter_600SemiBold' }]}>
                No inventory sessions in the last 14 days — results may be limited
              </Text>
              <Feather name="chevron-right" size={16} color={colors.warning} />
            </Pressable>
          )}

          <View style={[styles.inputArea, { borderTopColor: colors.border, backgroundColor: colors.background, paddingBottom: bottomInset + 8 }]}>
            <TextInput
              style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
              placeholder="Ask about inventory…"
              placeholderTextColor={colors.mutedForeground}
              value={input}
              onChangeText={setInput}
              multiline
              maxLength={1000}
              returnKeyType="send"
              onSubmitEditing={send}
              testID="chat-input"
            />
            <Pressable
              style={({ pressed }) => [styles.sendBtn, { backgroundColor: input.trim() ? colors.primary : colors.muted }, pressed && { opacity: 0.8 }]}
              onPress={send}
              disabled={!input.trim() || isThinking}
            >
              <Feather name="send" size={18} color={input.trim() ? '#fff' : colors.mutedForeground} />
            </Pressable>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  headerLeft: { flex: 1, minWidth: 60 },
  headerCenter: { flex: 2, alignItems: 'center' },
  title: { fontSize: 22 },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  storeText: { fontSize: 12 },
  headerActions: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  segmentTrack: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  segmentBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  segmentText: { fontSize: 13 },
  storeDropdown: {
    position: 'absolute', top: 80, left: 20, right: 20, zIndex: 100,
    borderRadius: 12, borderWidth: 1, boxShadow: '0 4px 8px rgba(0,0,0,0.15)', elevation: 8,
  },
  storeOption: { padding: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  storeOptionText: { fontSize: 15 },
  configBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 10, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  configBannerText: { flex: 1, fontSize: 13 },
  recentDataBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 4, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  recentDataBannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  messageList: { padding: 16, gap: 12 },
  msgRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 8 },
  msgRowUser: { flexDirection: 'row-reverse' },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  bubble: { maxWidth: '78%', borderRadius: 18, padding: 12 },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  emptyChat: { alignItems: 'center', gap: 12, paddingTop: 60, paddingHorizontal: 40 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: 20 },
  emptySub: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  inputArea: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  textInput: { flex: 1, borderRadius: 20, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  typingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typingText: { fontSize: 13 },
});
