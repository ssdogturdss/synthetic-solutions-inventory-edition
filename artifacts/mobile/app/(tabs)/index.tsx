import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, RefreshControl, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { useGetDashboardSummary } from '@workspace/api-client-react';
import { StatCard } from '@/components/StatCard';
import { SessionCard } from '@/components/SessionCard';
import { SyncBanner } from '@/components/SyncBanner';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const router = useRouter();
  const isAdmin = user?.role === 'admin';

  const { data: summary, isLoading, refetch, isRefetching } = useGetDashboardSummary({
    query: { queryKey: ['/api/dashboard/summary'], enabled: !!user },
  });

  const topPadding = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPadding = Platform.OS === 'web' ? 34 : insets.bottom + 90;

  if (isLoading) return <LoadingState message="Loading dashboard…" />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <SyncBanner />
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPadding + 12, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.greeting, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Good {getTimeOfDay()}
          </Text>
          <Text style={[styles.userName, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
            {user?.name}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {isAdmin && (
            <Pressable
              style={({ pressed }) => [styles.iconBtn, { backgroundColor: colors.muted }, pressed && { opacity: 0.7 }]}
              onPress={() => router.push('/admin')}
            >
              <Feather name="settings" size={20} color={colors.foreground} />
            </Pressable>
          )}
          <Pressable
            style={({ pressed }) => [styles.iconBtn, { backgroundColor: colors.muted }, pressed && { opacity: 0.7 }]}
            onPress={logout}
          >
            <Feather name="log-out" size={20} color={colors.foreground} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: bottomPadding }]}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Stat Cards */}
        <View style={styles.statsGrid}>
          <View style={styles.statsRow}>
            <StatCard
              label="Total Stores"
              value={summary?.storesTotal ?? 0}
              icon="map-pin"
              tint="primary"
              onPress={() => isAdmin && router.push('/admin/stores')}
            />
            <StatCard
              label="Pending Count"
              value={summary?.storesPendingInventory ?? 0}
              icon="clock"
              tint="warning"
              onPress={() => router.push('/(tabs)/inventory')}
            />
          </View>
          <View style={styles.statsRow}>
            <StatCard
              label="Below Min"
              value={summary?.itemsBelowMinimum ?? 0}
              icon="alert-triangle"
              tint="destructive"
              onPress={() => router.push('/reports/alerts')}
            />
            <StatCard
              label="Active Pulls"
              value={summary?.activeChemicalPulls ?? 0}
              icon="droplet"
              tint="success"
              onPress={() => router.push('/(tabs)/operations')}
            />
          </View>
        </View>

        {/* Quick Actions */}
        <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
          Quick Actions
        </Text>
        <View style={styles.quickActions}>
          {[
            { icon: 'clipboard' as const, label: 'New Count', onPress: () => router.push('/inventory/new'), color: colors.primary },
            { icon: 'package' as const, label: 'Log Delivery', onPress: () => router.push('/receive/new'), color: colors.info },
            { icon: 'droplet' as const, label: 'Pull Chemical', onPress: () => router.push('/usage/new'), color: colors.success },
            { icon: 'bell' as const, label: 'Notifications', onPress: () => router.push('/notifications' as Href), color: colors.accent },
            ...(isAdmin ? [{ icon: 'message-circle' as const, label: 'Ask AI', onPress: () => router.push('/(tabs)/chat'), color: colors.accent }] : []),
          ].map((a) => (
            <Pressable
              key={a.label}
              style={({ pressed }) => [styles.quickBtn, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.8 }]}
              onPress={a.onPress}
            >
              <View style={[styles.quickIcon, { backgroundColor: a.color + '18' }]}>
                <Feather name={a.icon} size={20} color={a.color} />
              </View>
              <Text style={[styles.quickLabel, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Top Chemicals */}
        {(summary?.topChemicals?.length ?? 0) > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              Top Chemicals
            </Text>
            {summary!.topChemicals.slice(0, 4).map((c, i) => (
              <View key={c.productId} style={[styles.chemRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.rank, { backgroundColor: colors.primary + '18' }]}>
                  <Text style={[styles.rankText, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>{i + 1}</Text>
                </View>
                <Text style={[styles.chemName, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]} numberOfLines={1}>
                  {c.productName}
                </Text>
                <Text style={[styles.chemUsage, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {parseFloat(c.totalUsage).toFixed(1)} {c.unit ?? ''}
                </Text>
              </View>
            ))}
          </>
        )}

        {/* Recent Sessions */}
        <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold', marginTop: 8 }]}>
          Recent Sessions
        </Text>
        {(summary?.recentSessions?.length ?? 0) === 0 ? (
          <EmptyState icon="clipboard" title="No sessions yet" subtitle="Start an inventory count to see activity here" />
        ) : (
          summary!.recentSessions.slice(0, 5).map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onPress={() => router.push(`/inventory/${s.id}`)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  greeting: { fontSize: 13 },
  userName: { fontSize: 22 },
  headerActions: { flexDirection: 'row', gap: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: 16, paddingTop: 20, gap: 0 },
  statsGrid: { gap: 10, marginBottom: 24 },
  statsRow: { flexDirection: 'row', gap: 10 },
  sectionTitle: { fontSize: 18, marginBottom: 12, marginTop: 4 },
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 24 },
  quickBtn: {
    width: '47%', borderRadius: 14, borderWidth: 1, padding: 16, gap: 10,
    elevation: 1, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  quickIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { fontSize: 14 },
  chemRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 10,
    borderWidth: 1, padding: 12, marginBottom: 8,
  },
  rank: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontSize: 13 },
  chemName: { flex: 1, fontSize: 14 },
  chemUsage: { fontSize: 13 },
});
