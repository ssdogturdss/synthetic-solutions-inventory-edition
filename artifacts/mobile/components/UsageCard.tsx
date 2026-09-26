import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { ChemicalUsage } from '@workspace/api-client-react';

interface UsageCardProps {
  usage: ChemicalUsage;
  productName?: string;
  onPress: () => void;
  onConsume?: () => void;
  onReturn?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: '#F59E0B',
  consumed: '#10B981',
  returned: '#6B7A99',
};

export function UsageCard({ usage, productName, onPress, onConsume, onReturn }: UsageCardProps) {
  const colors = useColors();
  const statusColor = STATUS_COLORS[usage.status] ?? colors.mutedForeground;
  const date = new Date(usage.pulledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <Pressable
      style={({ pressed }) => [styles.card, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.85 }]}
      onPress={onPress}
    >
      <View style={[styles.dot, { backgroundColor: statusColor }]} />
      <View style={styles.body}>
        <Text style={[styles.name, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
          {productName ?? `Product #${usage.productId}`}
        </Text>
        <Text style={[styles.meta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          {usage.amountPulled} · {date}
        </Text>
        {usage.reason && (
          <Text style={[styles.meta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {usage.reason}
          </Text>
        )}
      </View>
      {usage.status === 'active' && (
        <View style={styles.actions}>
          {onConsume && (
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.success + '22' }]} onPress={onConsume}>
              <Feather name="check" size={14} color={colors.success} />
            </Pressable>
          )}
          {onReturn && (
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.destructive + '22' }]} onPress={onReturn}>
              <Feather name="corner-up-left" size={14} color={colors.destructive} />
            </Pressable>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 12,
    marginBottom: 10,
    elevation: 1,
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 2 },
  body: { flex: 1, gap: 2 },
  name: { fontSize: 15 },
  meta: { fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
