import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { InventorySession } from '@workspace/api-client-react';

interface SessionCardProps {
  session: InventorySession;
  storeName?: string;
  onPress: () => void;
}

export function SessionCard({ session, storeName, onPress }: SessionCardProps) {
  const colors = useColors();
  const isFinalized = session.status === 'finalized';
  const statusColor = isFinalized ? colors.success : colors.warning;
  const date = new Date(session.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = new Date(session.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  return (
    <Pressable
      style={({ pressed }) => [styles.card, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.85 }]}
      onPress={onPress}
    >
      <View style={[styles.statusBar, { backgroundColor: statusColor }]} />
      <View style={styles.body}>
        <View style={styles.row}>
          <Text style={[styles.date, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
            {date} · {time}
          </Text>
          <View style={[styles.badge, { backgroundColor: statusColor + '22' }]}>
            <Text style={[styles.badgeText, { color: statusColor, fontFamily: 'Inter_600SemiBold' }]}>
              {isFinalized ? 'Finalized' : 'Open'}
            </Text>
          </View>
        </View>
        {storeName && (
          <Text style={[styles.store, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {storeName}
          </Text>
        )}
        <View style={styles.meta}>
          <Feather name="package" size={13} color={colors.mutedForeground} />
          <Text style={[styles.metaText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {session.itemCount ?? 0} items
          </Text>
        </View>
      </View>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} style={{ alignSelf: 'center' }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 10,
    elevation: 1,
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  statusBar: { width: 4 },
  body: { flex: 1, padding: 14, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  date: { fontSize: 15 },
  badge: { borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { fontSize: 12 },
  store: { fontSize: 13 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText: { fontSize: 12 },
});
