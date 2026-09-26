import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';

export function SyncBanner() {
  const colors = useColors();
  const { queuedCount, processQueue, isProcessing } = useOfflineQueue();

  if (queuedCount === 0) return null;

  return (
    <View style={[styles.banner, { backgroundColor: colors.warning }]}>
      <Feather name="wifi-off" size={14} color="#fff" />
      <Text style={[styles.text, { fontFamily: 'Inter_500Medium' }]}>
        {queuedCount} pending {queuedCount === 1 ? 'sync' : 'syncs'}
      </Text>
      <Pressable style={styles.btn} onPress={processQueue} disabled={isProcessing}>
        {isProcessing ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={[styles.btnText, { fontFamily: 'Inter_600SemiBold' }]}>Retry</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  text: { flex: 1, color: '#fff', fontSize: 13 },
  btn: { paddingHorizontal: 12, paddingVertical: 4, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 6 },
  btnText: { color: '#fff', fontSize: 12 },
});
