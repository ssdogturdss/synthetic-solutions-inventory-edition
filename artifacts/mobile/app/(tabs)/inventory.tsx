import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, RefreshControl, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { useListInventorySessions, useListStores } from '@workspace/api-client-react';
import { SessionCard } from '@/components/SessionCard';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';

type FilterStatus = 'all' | 'open' | 'finalized';

export default function InventoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const router = useRouter();
  const [filter, setFilter] = useState<FilterStatus>('all');
  const isAdmin = user?.role === 'admin';

  const topPadding = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPadding = Platform.OS === 'web' ? 34 : insets.bottom + 90;

  const { data: sessions, isLoading, refetch, isRefetching } = useListInventorySessions();
  const { data: stores } = useListStores();

  const storeMap = Object.fromEntries((stores ?? []).map((s) => [s.id, s.name]));

  const filtered = (sessions ?? []).filter((s) => {
    if (filter === 'all') return true;
    return s.status === filter;
  });

  if (isLoading) return <LoadingState message="Loading sessions…" />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPadding + 12, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>Inventory</Text>
        <Pressable
          style={({ pressed }) => [styles.fab, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }]}
          onPress={() => router.push('/inventory/new')}
        >
          <Feather name="plus" size={20} color="#fff" />
        </Pressable>
      </View>

      {/* Filters */}
      <View style={[styles.filters, { borderBottomColor: colors.border }]}>
        {(['all', 'open', 'finalized'] as FilterStatus[]).map((f) => (
          <Pressable
            key={f}
            style={[styles.filterBtn, filter === f && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, { color: filter === f ? colors.primary : colors.mutedForeground, fontFamily: filter === f ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(s) => String(s.id)}
        contentContainerStyle={[styles.list, { paddingBottom: bottomPadding }]}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            storeName={isAdmin ? storeMap[item.storeId] : undefined}
            onPress={() => router.push(`/inventory/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon="clipboard"
            title="No sessions"
            subtitle="Start a new inventory count"
            action={{ label: 'New Count', onPress: () => router.push('/inventory/new') }}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 28 },
  fab: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  filters: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  filterBtn: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  filterText: { fontSize: 14 },
  list: { padding: 16, paddingTop: 8 },
});
