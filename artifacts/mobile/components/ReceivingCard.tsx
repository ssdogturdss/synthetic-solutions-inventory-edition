import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { ReceivingRecord } from '@workspace/api-client-react';

interface ReceivingCardProps {
  record: ReceivingRecord;
  storeName?: string;
  warehouseName?: string;
  onPress: () => void;
}

export function ReceivingCard({ record, storeName, warehouseName, onPress }: ReceivingCardProps) {
  const colors = useColors();
  const date = new Date(record.receivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Pressable
      style={({ pressed }) => [styles.card, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.85 }]}
      onPress={onPress}
    >
      <View style={[styles.icon, { backgroundColor: colors.info + '18' }]}>
        <Feather name="package" size={20} color={colors.info} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
          {record.vendor ?? 'Unnamed Vendor'}
        </Text>
        <Text style={[styles.sub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          {date}{storeName ? ` · ${storeName}` : ''}{warehouseName ? ` · ${warehouseName}` : ''}
        </Text>
        {record.invoiceNumber && (
          <Text style={[styles.sub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Invoice #{record.invoiceNumber}
          </Text>
        )}
      </View>
      <View style={styles.right}>
        <Text style={[styles.items, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>{record.itemCount ?? 0}</Text>
        <Text style={[styles.itemsLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>items</Text>
      </View>
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
  icon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 15 },
  sub: { fontSize: 12 },
  right: { alignItems: 'center' },
  items: { fontSize: 22 },
  itemsLabel: { fontSize: 11 },
});
