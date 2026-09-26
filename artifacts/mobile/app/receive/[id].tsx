import React from 'react';
import { View, Text, StyleSheet, ScrollView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useGetReceivingRecord, useListProducts, useListWarehouses } from '@workspace/api-client-react';
import { LoadingState } from '@/components/LoadingState';

export default function ReceivingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const recordId = parseInt(id, 10);

  const { data: record, isLoading } = useGetReceivingRecord(recordId);
  const { data: products } = useListProducts();
  const { data: warehouses } = useListWarehouses();
  const productMap = Object.fromEntries((products ?? []).map((p) => [p.id, p.name]));

  if (isLoading) return <LoadingState message="Loading delivery…" />;
  if (!record) return null;

  const date = new Date(record.receivedAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.vendor, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
          {record.vendor ?? 'Unnamed Vendor'}
        </Text>
        <Text style={[styles.date, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{date}</Text>
        {record.warehouseId && (
          <View style={styles.metaRow}>
            <Feather name="home" size={14} color={colors.mutedForeground} />
            <Text style={[styles.meta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              {warehouses?.find((warehouse) => warehouse.id === record.warehouseId)?.name ?? 'Warehouse'}
            </Text>
          </View>
        )}
        {record.invoiceNumber && (
          <View style={styles.metaRow}>
            <Feather name="file-text" size={14} color={colors.mutedForeground} />
            <Text style={[styles.meta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>Invoice #{record.invoiceNumber}</Text>
          </View>
        )}
        {record.poNumber && (
          <View style={styles.metaRow}>
            <Feather name="hash" size={14} color={colors.mutedForeground} />
            <Text style={[styles.meta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>PO #{record.poNumber}</Text>
          </View>
        )}
        {record.notes && (
          <Text style={[styles.notes, { color: colors.foreground, fontFamily: 'Inter_400Regular', borderTopColor: colors.border }]}>
            {record.notes}
          </Text>
        )}
      </View>

      {/* Items */}
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
        ITEMS RECEIVED ({record.items.length})
      </Text>
      {record.items.map((item) => (
        <View key={item.id} style={[styles.itemCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.itemName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
            {productMap[item.productId] ?? `Product #${item.productId}`}
          </Text>
          <View style={styles.itemMeta}>
            <Text style={[styles.itemQty, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
              {item.quantityReceived}
            </Text>
            {item.lotNumber && (
              <Text style={[styles.itemMetaText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                Lot: {item.lotNumber}
              </Text>
            )}
            {item.expirationDate && (
              <Text style={[styles.itemMetaText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                Exp: {item.expirationDate}
              </Text>
            )}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 16 },
  card: { borderRadius: 14, borderWidth: 1, padding: 16, marginBottom: 20, gap: 6 },
  vendor: { fontSize: 20 },
  date: { fontSize: 14 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  meta: { fontSize: 13 },
  notes: { fontSize: 14, marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, lineHeight: 20 },
  sectionTitle: { fontSize: 12, letterSpacing: 0.6, marginBottom: 12 },
  itemCard: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  itemName: { fontSize: 15, marginBottom: 6 },
  itemMeta: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  itemQty: { fontSize: 18 },
  itemMetaText: { fontSize: 12 },
});
