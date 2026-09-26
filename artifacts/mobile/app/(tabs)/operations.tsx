import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, RefreshControl, Platform, Alert, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import {
  useListReceivingRecords, useListChemicalUsage, useUpdateChemicalUsage, useListProducts, useListStores, useListWarehouses,
  useListWarehouseMovements, getListWarehouseMovementsQueryKey,
} from '@workspace/api-client-react';
import type { WarehouseMovement } from '@workspace/api-client-react';
import { ReceivingCard } from '@/components/ReceivingCard';
import { UsageCard } from '@/components/UsageCard';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { BackupHealthCard } from '@/components/BackupHealthCard';
import { WarehouseOperationsPanel } from '@/components/WarehouseOperationsPanel';

type Tab = 'receive' | 'usage' | 'movements' | 'warehouse';

type MovementCardProps = {
  movement: WarehouseMovement;
  warehouseName?: string;
  sourceWarehouseName?: string;
  destinationWarehouseName?: string;
  destinationStoreName?: string;
  productName?: string;
  productUnit?: string | null;
  colors: ReturnType<typeof useColors>;
};

function MovementCard({
  movement,
  warehouseName,
  sourceWarehouseName,
  destinationWarehouseName,
  destinationStoreName,
  productName,
  productUnit,
  colors,
}: MovementCardProps) {
  const isTransfer = movement.movementType === 'transfer';
  const quantity = parseFloat(movement.quantity);
  const isIncoming = quantity > 0;
  const typeColor = movement.movementType === 'receipt'
    ? colors.success
    : movement.movementType === 'adjustment'
      ? colors.warning
      : colors.info;
  const icon: keyof typeof Feather.glyphMap = movement.movementType === 'receipt'
    ? 'download'
    : movement.movementType === 'adjustment'
      ? 'edit-3'
      : 'shuffle';
  const title = movement.movementType === 'receipt'
    ? 'Receipt'
    : movement.movementType === 'adjustment'
      ? 'Adjustment'
      : isIncoming
        ? 'Transfer in'
        : 'Transfer out';
  const transferDetail = isTransfer
    ? isIncoming
      ? `From ${sourceWarehouseName ?? 'another warehouse'}`
      : movement.destinationStoreId
        ? `To ${destinationStoreName ?? 'store'}`
        : `To ${destinationWarehouseName ?? 'another warehouse'}`
    : warehouseName ?? 'Warehouse';

  return (
    <View style={[styles.movementCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.movementIcon, { backgroundColor: typeColor + '18' }]}>
        <Feather name={icon} size={18} color={typeColor} />
      </View>
      <View style={styles.movementBody}>
        <View style={styles.movementTopRow}>
          <Text style={[styles.movementTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
            {title}
          </Text>
          <Text style={[styles.movementQuantity, { color: isIncoming ? colors.success : colors.destructive, fontFamily: 'Inter_700Bold' }]}>
            {quantity > 0 ? '+' : ''}{quantity.toFixed(3)}{productUnit ? ` ${productUnit}` : ''}
          </Text>
        </View>
        <Text style={[styles.movementProduct, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]} numberOfLines={1}>
          {productName ?? `Product #${movement.productId}`}
        </Text>
        <View style={styles.movementMeta}>
          <Text style={[styles.movementDetail, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]} numberOfLines={1}>
            {transferDetail}
          </Text>
          <Text style={[styles.movementDate, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {new Date(movement.movedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Text>
        </View>
        {movement.notes && (
          <Text style={[styles.movementNotes, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]} numberOfLines={2}>
            {movement.notes}
          </Text>
        )}
        {isTransfer && movement.transferGroupId && (
          <Text style={[styles.transferPair, { color: colors.info, fontFamily: 'Inter_500Medium' }]}>
            Transfer pair · {movement.transferGroupId.slice(0, 8)}
          </Text>
        )}
      </View>
    </View>
  );
}

export default function OperationsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('receive');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<number | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const isAdmin = user?.role === 'admin';

  const topPadding = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPadding = Platform.OS === 'web' ? 34 : insets.bottom + 90;

  const { data: receiving, isLoading: loadingRecv, refetch: refetchRecv, isRefetching: refetchingRecv } = useListReceivingRecords();
  const { data: usage, isLoading: loadingUsage, refetch: refetchUsage, isRefetching: refetchingUsage } = useListChemicalUsage();
  const { data: products } = useListProducts();
  const { data: stores } = useListStores();
  const { data: warehouses } = useListWarehouses();
  const movementParams = {
    warehouseId: selectedWarehouseId ?? undefined,
    productId: selectedProductId ?? undefined,
    limit: 200,
  };
  const {
    data: movements,
    isLoading: loadingMovements,
    refetch: refetchMovements,
    isRefetching: refetchingMovements,
  } = useListWarehouseMovements(movementParams, {
    query: {
      queryKey: getListWarehouseMovementsQueryKey(movementParams),
      enabled: isAdmin && tab === 'movements',
    },
  });

  const { mutateAsync: patchUsage } = useUpdateChemicalUsage();

  const productMap = Object.fromEntries((products ?? []).map((p) => [p.id, p.name]));
  const storeMap = Object.fromEntries((stores ?? []).map((s) => [s.id, s.name]));
  const warehouseMap = Object.fromEntries((warehouses ?? []).map((w) => [w.id, w.name]));

  const handleConsume = async (id: number) => {
    try {
      await patchUsage({ id, data: { status: 'consumed' } });
      refetchUsage();
    } catch { Alert.alert('Error', 'Could not update status.'); }
  };

  const handleReturn = async (id: number) => {
    try {
      await patchUsage({ id, data: { status: 'returned' } });
      refetchUsage();
    } catch { Alert.alert('Error', 'Could not update status.'); }
  };

  const isLoading = tab === 'receive'
    ? loadingRecv
    : tab === 'usage'
      ? loadingUsage
      : tab === 'movements'
        ? loadingMovements
        : false;
  if (isLoading) return <LoadingState message="Loading…" />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPadding + 12, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>Operations</Text>
        {(tab === 'receive' || tab === 'usage') && (
          <Pressable
            testID="operations-add-button"
            style={({ pressed }) => [styles.fab, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }]}
            onPress={() => router.push(tab === 'receive' ? '/receive/new' : '/usage/new')}
          >
            <Feather name="plus" size={20} color="#fff" />
          </Pressable>
        )}
      </View>

      {/* Segment */}
      <View style={[styles.segment, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        {(['receive', 'usage', ...(isAdmin ? ['movements' as const, 'warehouse' as const] : [])] as Tab[]).map((t) => (
          <Pressable
            key={t}
            testID={`operations-tab-${t}`}
            style={[styles.segBtn, tab === t && { backgroundColor: colors.card, boxShadow: '0 1px 2px rgba(0,0,0,0.1)', elevation: 2 }]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.segText, { color: tab === t ? colors.foreground : colors.mutedForeground, fontFamily: tab === t ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>
              {t === 'receive' ? 'Receiving' : t === 'usage' ? 'Pulls' : t === 'movements' ? 'Movements' : 'Warehouse'}
            </Text>
          </Pressable>
        ))}
      </View>
      {isAdmin && <BackupHealthCard />}

      {tab === 'warehouse' && isAdmin ? (
        <WarehouseOperationsPanel bottomPadding={bottomPadding} />
      ) : tab === 'warehouse' ? (
        <EmptyState icon="lock" title="Admin access required" subtitle="Warehouse operations are only available to administrators." />
      ) : tab === 'receive' ? (
        <FlatList
          data={receiving ?? []}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={[styles.list, { paddingBottom: bottomPadding }]}
          refreshControl={<RefreshControl refreshing={refetchingRecv} onRefresh={refetchRecv} tintColor={colors.primary} />}
          renderItem={({ item }) => (
            <ReceivingCard
              record={item}
              storeName={isAdmin && item.storeId !== null ? storeMap[item.storeId] : undefined}
              warehouseName={item.warehouseId ? warehouseMap[item.warehouseId] : undefined}
              onPress={() => router.push(`/receive/${item.id}`)}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="package"
              title="No deliveries logged"
              subtitle="Record a chemical delivery"
              action={{ label: 'Log Delivery', onPress: () => router.push('/receive/new') }}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      ) : tab === 'usage' ? (
        <FlatList
          data={usage ?? []}
          keyExtractor={(u) => String(u.id)}
          contentContainerStyle={[styles.list, { paddingBottom: bottomPadding }]}
          refreshControl={<RefreshControl refreshing={refetchingUsage} onRefresh={refetchUsage} tintColor={colors.primary} />}
          renderItem={({ item }) => (
            <UsageCard
              usage={item}
              productName={productMap[item.productId]}
              onPress={() => {}}
              onConsume={item.status === 'active' ? () => handleConsume(item.id) : undefined}
              onReturn={item.status === 'active' ? () => handleReturn(item.id) : undefined}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="droplet"
              title="No chemical pulls"
              subtitle="Pull a chemical into service"
              action={{ label: 'Pull Chemical', onPress: () => router.push('/usage/new') }}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      ) : (
        <FlatList
          data={movements ?? []}
          keyExtractor={(movement) => String(movement.id)}
          contentContainerStyle={[styles.list, { paddingBottom: bottomPadding }]}
          refreshControl={<RefreshControl refreshing={refetchingMovements} onRefresh={refetchMovements} tintColor={colors.primary} />}
          ListHeaderComponent={
            <View style={styles.filters}>
              <View style={styles.filterHeader}>
                <Text style={[styles.filterLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
                  FILTER BY WAREHOUSE
                </Text>
                <Pressable
                  testID="movement-warehouse-reset"
                  onPress={() => setSelectedWarehouseId(null)}
                  disabled={selectedWarehouseId === null}
                >
                  <Text style={[styles.resetText, { color: colors.primary, fontFamily: 'Inter_500Medium', opacity: selectedWarehouseId === null ? 0.4 : 1 }]}>
                    Reset
                  </Text>
                </Pressable>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                <Pressable
                  testID="movement-warehouse-all"
                  style={[styles.chip, { backgroundColor: selectedWarehouseId === null ? colors.primary : colors.card, borderColor: selectedWarehouseId === null ? colors.primary : colors.border }]}
                  onPress={() => setSelectedWarehouseId(null)}
                >
                  <Text style={[styles.chipText, { color: selectedWarehouseId === null ? colors.primaryForeground : colors.foreground, fontFamily: 'Inter_500Medium' }]}>All warehouses</Text>
                </Pressable>
                {(warehouses ?? []).map((warehouse) => (
                  <Pressable
                    key={warehouse.id}
                    testID={`movement-warehouse-${warehouse.id}`}
                    style={[styles.chip, { backgroundColor: selectedWarehouseId === warehouse.id ? colors.primary : colors.card, borderColor: selectedWarehouseId === warehouse.id ? colors.primary : colors.border }]}
                    onPress={() => setSelectedWarehouseId(warehouse.id)}
                  >
                    <Text style={[styles.chipText, { color: selectedWarehouseId === warehouse.id ? colors.primaryForeground : colors.foreground, fontFamily: 'Inter_500Medium' }]} numberOfLines={1}>
                      {warehouse.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={[styles.filterHeader, styles.productFilterHeader]}>
                <Text style={[styles.filterLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
                  FILTER BY PRODUCT
                </Text>
                <Pressable
                  testID="movement-product-reset"
                  onPress={() => setSelectedProductId(null)}
                  disabled={selectedProductId === null}
                >
                  <Text style={[styles.resetText, { color: colors.primary, fontFamily: 'Inter_500Medium', opacity: selectedProductId === null ? 0.4 : 1 }]}>
                    Reset
                  </Text>
                </Pressable>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                <Pressable
                  testID="movement-product-all"
                  style={[styles.chip, { backgroundColor: selectedProductId === null ? colors.primary : colors.card, borderColor: selectedProductId === null ? colors.primary : colors.border }]}
                  onPress={() => setSelectedProductId(null)}
                >
                  <Text style={[styles.chipText, { color: selectedProductId === null ? colors.primaryForeground : colors.foreground, fontFamily: 'Inter_500Medium' }]}>All products</Text>
                </Pressable>
                {(products ?? []).map((product) => (
                  <Pressable
                    key={product.id}
                    testID={`movement-product-${product.id}`}
                    style={[styles.chip, { backgroundColor: selectedProductId === product.id ? colors.primary : colors.card, borderColor: selectedProductId === product.id ? colors.primary : colors.border }]}
                    onPress={() => setSelectedProductId(product.id)}
                  >
                    <Text style={[styles.chipText, { color: selectedProductId === product.id ? colors.primaryForeground : colors.foreground, fontFamily: 'Inter_500Medium' }]} numberOfLines={1}>
                      {product.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={[styles.ledgerHint, { backgroundColor: colors.info + '12', borderColor: colors.info + '30' }]}>
                <Feather name="info" size={15} color={colors.info} />
                <Text style={[styles.ledgerHintText, { color: colors.info, fontFamily: 'Inter_400Regular' }]}>
                  Quantities are signed: receipts and transfers in add stock; transfers out and negative adjustments remove it.
                </Text>
              </View>
            </View>
          }
          renderItem={({ item }) => (
            <MovementCard
              movement={item}
              warehouseName={warehouseMap[item.warehouseId]}
              sourceWarehouseName={item.fromWarehouseId ? warehouseMap[item.fromWarehouseId] : undefined}
              destinationWarehouseName={item.toWarehouseId ? warehouseMap[item.toWarehouseId] : undefined}
              destinationStoreName={item.destinationStoreId ? storeMap[item.destinationStoreId] : undefined}
              productName={productMap[item.productId]}
              productUnit={products?.find((product) => product.id === item.productId)?.unit}
              colors={colors}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="shuffle"
              title="No warehouse movements"
              subtitle="Receipts, transfers, and adjustments will appear here"
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
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
  segment: { flexDirection: 'row', margin: 16, borderRadius: 12, padding: 4, borderWidth: 1 },
  segBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  segText: { fontSize: 14 },
  list: { paddingHorizontal: 16, paddingTop: 8 },
  filters: { paddingBottom: 6 },
  filterHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  productFilterHeader: { marginTop: 16 },
  filterLabel: { fontSize: 11, letterSpacing: 0.5 },
  resetText: { fontSize: 12 },
  chipRow: { gap: 8, paddingBottom: 2 },
  chip: { borderRadius: 18, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 8, maxWidth: 220 },
  chipText: { fontSize: 13 },
  ledgerHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 10, borderWidth: 1, padding: 10, marginTop: 16, marginBottom: 12 },
  ledgerHintText: { flex: 1, fontSize: 12, lineHeight: 17 },
  movementCard: { flexDirection: 'row', gap: 11, borderRadius: 12, borderWidth: 1, padding: 13, marginBottom: 9 },
  movementIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  movementBody: { flex: 1, minWidth: 0 },
  movementTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  movementTitle: { fontSize: 14 },
  movementQuantity: { fontSize: 14 },
  movementProduct: { fontSize: 14, marginTop: 4 },
  movementMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 5 },
  movementDetail: { flex: 1, fontSize: 12 },
  movementDate: { fontSize: 11 },
  movementNotes: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  transferPair: { fontSize: 11, marginTop: 6 },
});
