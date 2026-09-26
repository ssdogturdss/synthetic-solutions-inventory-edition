import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useGetBelowMinimumReport, useGetOverstockedReport } from '@workspace/api-client-react';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';

type Tab = 'below' | 'over';

export default function AlertsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('below');

  const { data: below, isLoading: loadingBelow } = useGetBelowMinimumReport();
  const { data: over, isLoading: loadingOver } = useGetOverstockedReport();

  const isLoading = tab === 'below' ? loadingBelow : loadingOver;
  const data = tab === 'below' ? (below ?? []) : (over ?? []);

  if (isLoading) return <LoadingState message="Loading alerts…" />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Segment */}
      <View style={[styles.segment, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        {(['below', 'over'] as Tab[]).map((t) => (
          <Pressable
            key={t}
            style={[styles.segBtn, tab === t && { backgroundColor: colors.card, boxShadow: '0 1px 2px rgba(0,0,0,0.1)', elevation: 2 }]}
            onPress={() => setTab(t)}
          >
            <Feather
              name={t === 'below' ? 'alert-triangle' : 'trending-up'}
              size={14}
              color={tab === t ? (t === 'below' ? colors.destructive : colors.warning) : colors.mutedForeground}
            />
            <Text style={[styles.segText, { color: tab === t ? colors.foreground : colors.mutedForeground, fontFamily: tab === t ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>
              {t === 'below' ? `Below Min (${below?.length ?? 0})` : `Overstocked (${over?.length ?? 0})`}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={data}
        keyExtractor={(a) => `${a.storeId}-${a.productId}`}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item }) => {
          const isCritical = tab === 'below';
          const alertColor = isCritical ? colors.destructive : colors.warning;
          const pct = parseFloat(item.currentLevel) / parseFloat(item.threshold);
          return (
            <View style={[styles.alertCard, { backgroundColor: colors.card, borderColor: alertColor + '40', borderLeftColor: alertColor }]}>
              <View style={styles.alertTop}>
                <Text style={[styles.alertProduct, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]} numberOfLines={1}>
                  {item.productName}
                </Text>
                <View style={[styles.alertBadge, { backgroundColor: alertColor + '18' }]}>
                  <Text style={[styles.alertBadgeText, { color: alertColor, fontFamily: 'Inter_700Bold' }]}>
                    {parseFloat(item.currentLevel).toFixed(1)}
                  </Text>
                </View>
              </View>
              <Text style={[styles.alertStore, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {item.storeName}
              </Text>
              <View style={styles.alertThreshold}>
                <Text style={[styles.alertThresholdText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {isCritical ? 'Min' : 'Max'}: {item.threshold} {item.unit ?? ''}
                </Text>
                <Text style={[styles.alertPct, { color: alertColor, fontFamily: 'Inter_600SemiBold' }]}>
                  {(pct * 100).toFixed(0)}% of threshold
                </Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            icon={tab === 'below' ? 'check-circle' : 'check-circle'}
            title={tab === 'below' ? 'All levels OK' : 'No overstock issues'}
            subtitle={tab === 'below' ? 'No products are below minimum level' : 'No products exceed maximum levels'}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  segment: { flexDirection: 'row', margin: 16, borderRadius: 12, padding: 4, borderWidth: 1 },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingVertical: 10 },
  segText: { fontSize: 13 },
  list: { paddingHorizontal: 16 },
  alertCard: { borderRadius: 12, borderWidth: 1, borderLeftWidth: 4, padding: 14, marginBottom: 10 },
  alertTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  alertProduct: { flex: 1, fontSize: 15, marginRight: 10 },
  alertBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  alertBadgeText: { fontSize: 16 },
  alertStore: { fontSize: 13, marginBottom: 6 },
  alertThreshold: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  alertThresholdText: { fontSize: 12 },
  alertPct: { fontSize: 12 },
});
