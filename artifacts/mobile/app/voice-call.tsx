/**
 * voice-call.tsx
 *
 * Voice / text AI conversation screen.
 *
 * Speech recognition strategy:
 *   - Web:    browser built-in Web Speech API (window.SpeechRecognition) — no package needed.
 *   - Native: text-input only.  expo-speech-recognition requires a custom dev build and
 *             is NOT imported here at all; Metro would bundle it and crash Expo Go.
 *
 * Text-to-speech (AI replies):
 *   - expo-speech works in all environments including Expo Go and the web preview.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, Platform,
  ScrollView, StatusBar, TextInput, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { useAiChat } from '@workspace/api-client-react';
import type { AiChatMessage } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/AuthContext';

// Web Speech API — typed as `any` because the RN tsconfig doesn't include DOM lib.
/* eslint-disable @typescript-eslint/no-explicit-any */
type WebSR = any;
declare global {
  interface Window {
    SpeechRecognition: (new () => WebSR) | undefined;
    webkitSpeechRecognition: (new () => WebSR) | undefined;
  }
}

type CallPhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export default function VoiceCallScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { mutateAsync: sendMessage } = useAiChat();

  const [phase, setPhase] = useState<CallPhase>('connecting');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [interimText, setInterimText] = useState('');
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [muted, setMuted] = useState(false);
  // null = detecting, true = web SR works, false = text-input mode
  const [srAvailable, setSrAvailable] = useState<boolean | null>(null);
  const [textInput, setTextInput] = useState('');

  const historyRef = useRef<AiChatMessage[]>([]);
  const phaseRef = useRef<string>('connecting');
  const mutedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const srRef = useRef<WebSR>(null);
  const inputRef = useRef<TextInput>(null);

  const setPhaseSync = (p: CallPhase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // ── Web Speech Recognition ───────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    try { srRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  // Forward-declared so startListening can reference it
  const handleUserSpeechRef = useRef<((text: string) => Promise<void>) | undefined>(undefined);

  const startListening = useCallback(() => {
    if (Platform.OS !== 'web') return;
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) return;
    try {
      const recognition: WebSR = new SR();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      srRef.current = recognition;

      recognition.onresult = (event: any) => {
        const result = event.results[event.results.length - 1];
        if (!result) return;
        if (result.isFinal) {
          setInterimText('');
          const text = result[0]?.transcript?.trim();
          if (text) handleUserSpeechRef.current?.(text);
        } else {
          setInterimText(result[0]?.transcript ?? '');
        }
      };

      recognition.onend = () => {
        setInterimText('');
        if (phaseRef.current === 'listening' && !mutedRef.current) {
          setTimeout(() => {
            if (phaseRef.current === 'listening') startListening();
          }, 150);
        }
      };

      recognition.onerror = () => {
        if (phaseRef.current === 'listening' && !mutedRef.current) {
          setTimeout(() => {
            if (phaseRef.current === 'listening') startListening();
          }, 500);
        }
      };

      recognition.start();
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const returnToListening = useCallback(() => {
    if (phaseRef.current === 'ended') return;
    setPhaseSync('listening');
    stopListening();
    setTimeout(() => {
      if (phaseRef.current === 'listening') startListening();
    }, 150);
  }, [startListening, stopListening]);

  const handleUserSpeech = useCallback(async (text: string) => {
    if (phaseRef.current === 'ended') return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    stopListening();

    const userTurn: AiChatMessage = { role: 'user', content: text };
    historyRef.current = [...historyRef.current, userTurn];
    setTurns((prev) => [...prev, { role: 'user', content: text }]);
    setPhaseSync('thinking');

    let reply = '';
    try {
      const resp = await sendMessage({
        data: {
          messages: historyRef.current,
          storeId: user?.role === 'admin' ? null : (user?.storeId ?? null),
        },
      });
      reply = resp.message;
    } catch {
      reply = 'Sorry, I had trouble reaching the AI. Please try again.';
    }

    const aiTurn: AiChatMessage = { role: 'assistant', content: reply };
    historyRef.current = [...historyRef.current, aiTurn];
    setTurns((prev) => [...prev, { role: 'assistant', content: reply }]);

    if (phaseRef.current === 'ended') return;
    setPhaseSync('speaking');

    const backToListening = () => {
      if (srAvailable) returnToListening();
      else {
        setPhaseSync('listening');
        // Re-focus input after AI responds in text mode
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    };

    if (!mutedRef.current) {
      let speechDone = false;
      const pollInterval = setInterval(async () => {
        if (phaseRef.current === 'ended') { clearInterval(pollInterval); return; }
        const speaking = await Speech.isSpeakingAsync();
        if (!speaking && !speechDone) {
          speechDone = true;
          clearInterval(pollInterval);
          backToListening();
        }
      }, 400);

      Speech.speak(reply, {
        language: 'en-US',
        rate: 0.95,
        pitch: 1.0,
        onDone: () => { if (!speechDone) { speechDone = true; clearInterval(pollInterval); backToListening(); } },
        onStopped: () => { if (!speechDone) { speechDone = true; clearInterval(pollInterval); backToListening(); } },
        onError: () => { if (!speechDone) { speechDone = true; clearInterval(pollInterval); backToListening(); } },
      });
    } else {
      backToListening();
    }
  }, [sendMessage, returnToListening, stopListening, user, srAvailable]);

  // Keep the ref in sync so startListening's closure can call it
  useEffect(() => { handleUserSpeechRef.current = handleUserSpeech; }, [handleUserSpeech]);

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  useEffect(() => {
    StatusBar.setBarStyle('light-content');
    timerRef.current = setInterval(() => setElapsedSecs((s) => s + 1), 1000);

    const t = setTimeout(() => {
      const webSRAvailable =
        Platform.OS === 'web' &&
        !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

      setSrAvailable(webSRAvailable);
      setPhaseSync('listening');

      if (webSRAvailable) {
        startListening();
      } else {
        // Text-input mode — focus the input so keyboard appears immediately
        setTimeout(() => inputRef.current?.focus(), 150);
      }
    }, 600);

    return () => {
      clearTimeout(t);
      if (timerRef.current) clearInterval(timerRef.current);
      stopListening();
      Speech.stop();
      StatusBar.setBarStyle('default');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goBack = useCallback(() => {
    stopListening();
    Speech.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setPhaseSync('ended');
    setTimeout(() => router.back(), 150);
  }, [router, stopListening]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) Speech.stop();
  }, []);

  const handleSendText = useCallback(() => {
    const text = textInput.trim();
    if (!text || phase === 'thinking') return;
    setTextInput('');
    handleUserSpeech(text);
  }, [textInput, phase, handleUserSpeech]);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [turns]);

  // ── Derived display values ───────────────────────────────────────────────────
  const formatTime = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const phaseLabel: Record<CallPhase, string> = {
    connecting: 'Connecting…',
    listening: srAvailable ? 'Listening…' : 'Type a message',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
    ended: 'Ended',
  };

  const dotColor =
    phase === 'listening' ? '#22C55E' :
    phase === 'thinking'  ? '#F59E0B' :
    phase === 'speaking'  ? '#60A5FA' : '#EF4444';

  const isTextMode = srAvailable === false;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        {/* Back / close button — always visible */}
        <Pressable
          style={styles.backBtn}
          onPress={goBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Feather name="chevron-down" size={24} color="#94A3B8" />
        </Pressable>

        <View style={styles.headerCenter}>
          <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
          <Text style={styles.headerTitle}>Inventory AI</Text>
          <Text style={styles.phaseLabel}>{phaseLabel[phase]}</Text>
        </View>

        <Text style={styles.timer}>{formatTime(elapsedSecs)}</Text>
      </View>

      {/* Text-mode notice */}
      {isTextMode && (
        <View style={styles.textModeBanner}>
          <Feather name="message-square" size={13} color="#60A5FA" />
          <Text style={styles.textModeBannerText}>
            Voice input requires a native build — type below
          </Text>
        </View>
      )}

      {/* Interim speech text (web voice mode) */}
      {!isTextMode && interimText.length > 0 && (
        <View style={styles.interimBubble}>
          <Text style={styles.interimText}>"{interimText}"</Text>
        </View>
      )}

      {/* Transcript */}
      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {turns.length === 0 && (
          <Text style={styles.transcriptEmpty}>
            {isTextMode
              ? 'Type a message to start talking to the AI.'
              : 'Start speaking — the conversation will appear here.'}
          </Text>
        )}
        {turns.map((t, i) => (
          <View key={i} style={[styles.turnRow, t.role === 'user' && styles.turnRowUser]}>
            <Text style={[styles.turnLabel, t.role === 'user' && styles.turnLabelUser]}>
              {t.role === 'user' ? 'You' : 'AI'}
            </Text>
            <View style={[styles.bubble, t.role === 'user' ? styles.bubbleUser : styles.bubbleAI]}>
              <Text style={[styles.turnText, t.role === 'user' && styles.turnTextUser]}>
                {t.content}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Text-input bar */}
      {isTextMode && (
        <View style={[styles.textInputArea, { paddingBottom: insets.bottom + 8 }]}>
          <TextInput
            ref={inputRef}
            style={styles.textInputField}
            value={textInput}
            onChangeText={setTextInput}
            placeholder="Ask about inventory…"
            placeholderTextColor="#475569"
            multiline
            maxLength={1000}
            returnKeyType="send"
            onSubmitEditing={handleSendText}
            editable={phase !== 'thinking' && phase !== 'ended'}
          />
          <Pressable
            style={[styles.sendBtn, { opacity: textInput.trim() && phase !== 'thinking' ? 1 : 0.4 }]}
            onPress={handleSendText}
            disabled={!textInput.trim() || phase === 'thinking'}
          >
            <Feather name="send" size={18} color="#fff" />
          </Pressable>
        </View>
      )}

      {/* Voice-mode controls */}
      {!isTextMode && (
        <View style={[styles.controls, { paddingBottom: insets.bottom + 24 }]}>
          <Pressable
            style={[styles.controlBtn, muted && styles.controlBtnActive]}
            onPress={toggleMute}
          >
            <Feather name={muted ? 'volume-x' : 'volume-2'} size={20} color={muted ? '#0D1526' : '#fff'} />
            <Text style={[styles.controlLabel, muted && { color: '#0D1526' }]}>
              {muted ? 'Unmute' : 'Mute AI'}
            </Text>
          </Pressable>

          <Pressable style={styles.endBtn} onPress={goBack}>
            <Feather name="phone-off" size={26} color="#fff" />
          </Pressable>

          <View style={[styles.controlBtn, { opacity: 0 }]} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B1829' },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E3A5F',
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  headerTitle: { color: '#E2E8F0', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  phaseLabel: { color: '#64748B', fontSize: 12, fontFamily: 'Inter_400Regular' },
  timer: {
    width: 40,
    color: '#475569',
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textAlign: 'right',
  },

  // Notice / interim
  textModeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginTop: 10,
    backgroundColor: '#0F2440', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: '#1E4080',
  },
  textModeBannerText: { flex: 1, color: '#60A5FA', fontSize: 13, fontFamily: 'Inter_400Regular' },
  interimBubble: {
    marginHorizontal: 16, marginTop: 8,
    backgroundColor: '#0F2440', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1, borderColor: '#1E4080',
  },
  interimText: { color: '#60A5FA', fontSize: 15, fontFamily: 'Inter_400Regular', fontStyle: 'italic' },

  // Transcript
  transcript: { flex: 1 },
  transcriptContent: { padding: 20, gap: 20, flexGrow: 1, justifyContent: 'flex-end' },
  transcriptEmpty: {
    color: '#334155', fontSize: 15, fontFamily: 'Inter_400Regular',
    textAlign: 'center', paddingVertical: 40, lineHeight: 22,
  },
  turnRow: { gap: 5, alignSelf: 'flex-start', maxWidth: '88%' },
  turnRowUser: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  turnLabel: {
    color: '#475569', fontSize: 11, fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: 4,
  },
  turnLabelUser: { color: '#3B82F6' },
  bubble: { borderRadius: 18, paddingHorizontal: 18, paddingVertical: 14 },
  bubbleAI: { backgroundColor: '#132336', borderWidth: 1, borderColor: '#1E3A5F', borderBottomLeftRadius: 4 },
  bubbleUser: { backgroundColor: '#1D4ED8', borderBottomRightRadius: 4 },
  turnText: { color: '#CBD5E1', fontSize: 16, fontFamily: 'Inter_400Regular', lineHeight: 24 },
  turnTextUser: { color: '#EFF6FF' },

  // Text input
  textInputArea: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#1E3A5F',
    backgroundColor: '#0B1829',
  },
  textInputField: {
    flex: 1, backgroundColor: '#132336', borderRadius: 20,
    borderWidth: 1, borderColor: '#1E3A5F',
    color: '#E2E8F0', fontFamily: 'Inter_400Regular',
    fontSize: 15, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#1D4ED8', alignItems: 'center', justifyContent: 'center',
  },

  // Voice controls
  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    paddingTop: 20, paddingHorizontal: 32,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#1E3A5F',
  },
  controlBtn: {
    alignItems: 'center', gap: 6, backgroundColor: '#1E2D40',
    borderRadius: 40, paddingHorizontal: 18, paddingVertical: 12, minWidth: 80,
  },
  controlBtnActive: { backgroundColor: '#60A5FA' },
  controlLabel: { color: '#94A3B8', fontSize: 11, fontFamily: 'Inter_500Medium' },
  endBtn: {
    width: 68, height: 68, borderRadius: 34, backgroundColor: '#EF4444',
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 4px 12px rgba(239,68,68,0.4)', elevation: 12,
  },
});
