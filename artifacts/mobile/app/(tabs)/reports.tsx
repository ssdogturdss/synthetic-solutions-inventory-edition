import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useGetBelowMinimumReport, useGetTopConsumersReport } from '@workspace/api-client-react';

const REPORTS = [
  { id: 'usage-report', title: 'Usage Report', subtitle: 'Consumption by product, store, period', icon: 'trending-up' as const, tint: 'primary' },
  { id: 'alerts', title: 'Stock Alerts', subtitle: 'Below minimum & overstocked items', icon: 'alert-triangle' as const, tint: 'destructive' },
  { id: 'valuation', title: 'Inventory Valuation', subtitle: 'Current on-hand value by store', icon: 'dollar-sign' as const, tint: 'success' },
];

export default function ReportsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const topPadding = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPadding = Platform.OS === 'web' ? 34 : insets.bottom + 90;

  const { data: alerts } = useGetBelowMinimumReport();
  const { data: topConsumers } = useGetTopConsumersReport();

  const tintMap: Record<string, string> = {
    primary: colors.primary,
    destructive: colors.destructive,
    success: colors.success,
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPadding + 12, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>Reports</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: bottomPadding }]} showsVerticalScrollIndicator={false}>
        {/* Summary banners */}
        {(alerts?.length ?? 0) > 0 && (
          <Pressable
            style={[styles.banner, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '40' }]}
            onPress={() => router.push('/reports/alerts')}
          >
            <Feather name="alert-triangle" size={18} color={colors.destructive} />
            <Text style={[styles.bannerText, { color: colors.destructive, fontFamily: 'Inter_600SemiBold' }]}>
              {alerts!.length} item{alerts!.length !== 1 ? 's' : ''} below minimum level
            </Text>
            <Feather name="chevron-right" size={16} color={colors.destructive} />
          </Pressable>
        )}

        {/* Report cards */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
          AVAILABLE REPORTS
        </Text>
        {REPORTS.map((r) => (
          <Pressable
            key={r.id}
            style={({ pressed }) => [styles.reportCard, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.85 }]}
            onPress={() => router.push(`/reports/${r.id}` as any)}
          >
            <View style={[styles.reportIcon, { backgroundColor: tintMap[r.tint] + '18' }]}>
              <Feather name={r.icon} size={22} color={tintMap[r.tint]} />
            </View>
            <View style={styles.reportInfo}>
              <Text style={[styles.reportTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>{r.title}</Text>
              <Text style={[styles.reportSub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{r.subtitle}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
          </Pressable>
        ))}

        {/* Top consumers preview */}
        {(topConsumers?.topProducts?.length ?? 0) > 0 && (
          <>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold', marginTop: 24 }]}>
              TOP CONSUMERS (30 DAYS)
            </Text>
            {topConsumers!.topProducts.slice(0, 5).map((p, i) => (
              <View key={p.productId} style={[styles.topRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.topRank, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>#{i + 1}</Text>
                <Text style={[styles.topName, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]} numberOfLines={1}>{p.productName}</Text>
                <Text style={[styles.topUsage, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {parseFloat(p.totalUsage).toFixed(1)} {p.unit ?? ''}
                </Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 28 },
  scroll: { padding: 16 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 20 },
  bannerText: { flex: 1, fontSize: 14 },
  sectionLabel: { fontSize: 12, letterSpacing: 0.6, marginBottom: 12 },
  reportCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 14, borderWidth: 1,
    padding: 16, marginBottom: 10,
    elevation: 1, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  reportIcon: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  reportInfo: { flex: 1 },
  reportTitle: { fontSize: 16 },
  reportSub: { fontSize: 13, marginTop: 2 },
  topRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 10,
    borderWidth: 1, padding: 12, marginBottom: 8,
  },
  topRank: { width: 30, fontSize: 14 },
  topName: { flex: 1, fontSize: 14 },
  topUsage: { fontSize: 13 },
});
