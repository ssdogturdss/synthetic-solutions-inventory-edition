import React, { useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetWarehouseStockQueryKey,
  getListReceivingRecordsQueryKey,
  getListWarehouseMovementsQueryKey,
  useCreateWarehouseTransfer,
  useGetWarehouseStock,
  useListProducts,
  useListStores,
  useListWarehouses,
} from '@workspace/api-client-react';
import type { WarehouseStockLine } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { getApiErrorMessage } from '@/lib/api-error';

type TransferLine = {
  id: string;
  productId: number | null;
  quantity: string;
};

type Props = {
  bottomPadding: number;
};

const blankLine = (suffix = '1'): TransferLine => ({
  id: `${Date.now()}-${suffix}`,
  productId: null,
  quantity: '',
});

export function WarehouseOperationsPanel({ bottomPadding }: Props) {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [storePickerOpen, setStorePickerOpen] = useState(false);
  const [productPickerOpen, setProductPickerOpen] = useState<string | null>(null);
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [lines, setLines] = useState<TransferLine[]>([blankLine()]);

  const { data: warehouses, isLoading: loadingWarehouses } = useListWarehouses();
  const { data: stores } = useListStores();
  const { data: products } = useListProducts({ activeOnly: true });
  const activeWarehouses = (warehouses ?? []).filter((warehouse) => warehouse.isActive);
  const activeStores = (stores ?? []).filter((store) => store.isActive);
  const selectedWarehouse = activeWarehouses.find((warehouse) => warehouse.id === warehouseId)
    ?? activeWarehouses[0];
  const selectedStore = activeStores.find((store) => store.id === storeId)
    ?? activeStores[0];
  const stockWarehouseId = selectedWarehouse?.id ?? 0;
  const {
    data: stock,
    isLoading: loadingStock,
    isRefetching,
    refetch: refetchStock,
  } = useGetWarehouseStock(stockWarehouseId, {
    query: {
      queryKey: getGetWarehouseStockQueryKey(stockWarehouseId),
      enabled: Boolean(selectedWarehouse),
    },
  });
  const { mutateAsync: createTransfer, isPending } = useCreateWarehouseTransfer();

  const productById = useMemo(
    () => new Map((products ?? []).map((product) => [product.id, product])),
    [products],
  );
  const stockByProduct = useMemo(
    () => new Map((stock ?? []).map((line: WarehouseStockLine) => [line.productId, Number(line.quantity)])),
    [stock],
  );
  const sortedStock = useMemo(
    () => [...(stock ?? [])].sort((a, b) =>
      (productById.get(a.productId)?.name ?? '').localeCompare(productById.get(b.productId)?.name ?? ''),
    ),
    [productById, stock],
  );

  const updateLine = (id: string, patch: Partial<TransferLine>) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const handleTransfer = async () => {
    if (!selectedWarehouse) {
      Alert.alert('Warehouse required', 'Create or activate a warehouse before transferring stock.');
      return;
    }
    if (!selectedStore) {
      Alert.alert('Store required', 'Create or activate a destination store before transferring stock.');
      return;
    }
    if (lines.some((line) => !line.productId || !/^\d+(\.\d{1,3})?$/.test(line.quantity) || Number(line.quantity) <= 0)) {
      Alert.alert('Check transfer items', 'Choose a product and enter a quantity greater than zero (up to 3 decimal places) on every line.');
      return;
    }

    const productIds = lines.map((line) => line.productId!);
    if (new Set(productIds).size !== productIds.length) {
      Alert.alert('Duplicate product', 'Each product can appear only once in a transfer.');
      return;
    }
    const insufficient = lines.find((line) => Number(line.quantity) > (stockByProduct.get(line.productId!) ?? 0));
    if (insufficient) {
      const productName = productById.get(insufficient.productId!)?.name ?? 'This product';
      Alert.alert('Not enough stock', `${productName} does not have enough available stock in this warehouse.`);
      return;
    }

    try {
      const response = await createTransfer({
        data: {
          sourceWarehouseId: selectedWarehouse.id,
          destinationStoreId: selectedStore.id,
          items: lines.map((line) => ({ productId: line.productId!, quantity: line.quantity })),
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetWarehouseStockQueryKey(selectedWarehouse.id) }),
        queryClient.invalidateQueries({ queryKey: getListWarehouseMovementsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListReceivingRecordsQueryKey() }),
      ]);
      await refetchStock();
      setLines([blankLine(String(Date.now()))]);
      setShowTransferForm(false);
      Alert.alert(
        'Transfer recorded',
        `${lines.length} item${lines.length === 1 ? '' : 's'} sent to ${selectedStore.name} · ${response.transferGroupId.slice(0, 8)}.`,
      );
    } catch (error) {
      Alert.alert('Transfer failed', getApiErrorMessage(error, 'Stock was not transferred. Check the available quantity and try again.'));
    }
  };

  const renderWarehousePicker = () => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {activeWarehouses.map((warehouse) => {
        const selected = selectedWarehouse?.id === warehouse.id;
        return (
          <Pressable
            key={warehouse.id}
            testID={`warehouse-stock-select-${warehouse.id}`}
            style={[
              styles.warehouseChip,
              {
                backgroundColor: selected ? colors.primary : colors.card,
                borderColor: selected ? colors.primary : colors.border,
              },
            ]}
            onPress={() => setWarehouseId(warehouse.id)}
          >
            <Feather name="home" size={14} color={selected ? colors.primaryForeground : colors.mutedForeground} />
            <Text
              style={[
                styles.chipText,
                { color: selected ? colors.primaryForeground : colors.foreground, fontFamily: 'Inter_500Medium' },
              ]}
              numberOfLines={1}
            >
              {warehouse.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  if (loadingWarehouses) return <LoadingState message="Loading warehouses…" />;

  return (
    <KeyboardAwareScrollViewCompat
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={72}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => { void refetchStock(); }}
          tintColor={colors.primary}
        />
      }
    >
      {!selectedWarehouse ? (
        <EmptyState
          icon="home"
          title="Set up a warehouse"
          subtitle="Create or activate a warehouse before receiving or transferring stock."
          action={{ label: 'Manage Warehouses', onPress: () => router.push('/admin/warehouses') }}
        />
      ) : (
        <>
          <View style={[styles.introCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.introIcon, { backgroundColor: colors.primary + '18' }]}>
              <Feather name="package" size={19} color={colors.primary} />
            </View>
            <View style={styles.introCopy}>
              <Text style={[styles.introTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                Central stock
              </Text>
              <Text style={[styles.introText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                Current balances include finalized counts, receipts, adjustments, and transfers.
              </Text>
            </View>
          </View>

          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
            WAREHOUSE
          </Text>
          {renderWarehousePicker()}

          <View style={styles.actionRow}>
            <Pressable
              testID="warehouse-receive-button"
              style={({ pressed }) => [
                styles.secondaryAction,
                { backgroundColor: colors.card, borderColor: colors.border },
                pressed && { opacity: 0.82 },
              ]}
              onPress={() => router.push('/receive/new?destination=warehouse')}
            >
              <Feather name="download" size={16} color={colors.primary} />
              <Text style={[styles.actionText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                Receive stock
              </Text>
            </Pressable>
            <Pressable
              testID="warehouse-transfer-toggle"
              style={({ pressed }) => [
                styles.primaryAction,
                { backgroundColor: colors.primary, borderColor: colors.primary },
                pressed && { opacity: 0.82 },
              ]}
              onPress={() => setShowTransferForm((visible) => !visible)}
            >
              <Feather name={showTransferForm ? 'x' : 'truck'} size={16} color={colors.primaryForeground} />
              <Text style={[styles.actionText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
                {showTransferForm ? 'Close transfer' : 'Transfer to store'}
              </Text>
            </Pressable>
          </View>

          {showTransferForm && (
            <View style={[styles.transferCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.transferTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                Send stock to a store
              </Text>
              <Text style={[styles.helperText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                This records the warehouse reduction and adds the delivery to the store’s receiving history.
              </Text>

              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>DESTINATION STORE</Text>
              <Pressable
                testID="warehouse-transfer-store-picker"
                style={[styles.picker, { backgroundColor: colors.background, borderColor: colors.border }]}
                onPress={() => setStorePickerOpen((open) => !open)}
              >
                <Feather name="map-pin" size={16} color={colors.mutedForeground} />
                <Text style={[styles.pickerText, { color: selectedStore ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {selectedStore?.name ?? 'Select store…'}
                </Text>
                <Feather name={storePickerOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
              </Pressable>
              {storePickerOpen && (
                <View style={[styles.dropdown, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  {activeStores.length === 0 ? (
                    <Text style={[styles.emptyPicker, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                      No active stores available.
                    </Text>
                  ) : activeStores.map((store) => (
                    <Pressable
                      key={store.id}
                      testID={`warehouse-transfer-store-${store.id}`}
                      style={[styles.dropdownItem, { borderBottomColor: colors.border }]}
                      onPress={() => { setStoreId(store.id); setStorePickerOpen(false); }}
                    >
                      <Text style={[styles.dropdownText, { color: store.id === selectedStore?.id ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>
                        {store.name}
                      </Text>
                      {store.id === selectedStore?.id && <Feather name="check" size={16} color={colors.primary} />}
                    </Pressable>
                  ))}
                </View>
              )}

              <View style={styles.linesHeader}>
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>ITEMS</Text>
                <Pressable
                  testID="warehouse-transfer-add-line"
                  style={[styles.addLineButton, { backgroundColor: colors.primary + '18' }]}
                  onPress={() => setLines((current) => [...current, blankLine(String(current.length + 1))])}
                >
                  <Feather name="plus" size={14} color={colors.primary} />
                  <Text style={[styles.addLineText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>Add item</Text>
                </Pressable>
              </View>

              {lines.map((line, index) => {
                const selectedProduct = productById.get(line.productId ?? -1);
                const available = line.productId == null ? null : stockByProduct.get(line.productId) ?? 0;
                const alreadyUsed = new Set(lines.filter((other) => other.id !== line.id).map((other) => other.productId));
                return (
                  <View key={line.id} style={[styles.lineCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
                    <View style={styles.lineHeading}>
                      <Text style={[styles.lineTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                        Item {index + 1}
                      </Text>
                      {lines.length > 1 && (
                        <Pressable
                          testID={`warehouse-transfer-remove-${line.id}`}
                          accessibilityLabel={`Remove item ${index + 1}`}
                          onPress={() => setLines((current) => current.filter((item) => item.id !== line.id))}
                        >
                          <Feather name="trash-2" size={16} color={colors.destructive} />
                        </Pressable>
                      )}
                    </View>
                    <Pressable
                      testID={`warehouse-transfer-product-picker-${line.id}`}
                      style={[styles.picker, styles.productPicker, { backgroundColor: colors.card, borderColor: colors.border }]}
                      onPress={() => setProductPickerOpen((open) => open === line.id ? null : line.id)}
                    >
                      <Feather name="package" size={15} color={colors.mutedForeground} />
                      <Text style={[styles.pickerText, { color: selectedProduct ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                        {selectedProduct?.name ?? 'Select product…'}
                      </Text>
                      <Feather name={productPickerOpen === line.id ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
                    </Pressable>
                    {productPickerOpen === line.id && (
                      <ScrollView
                        style={[styles.productDropdown, { backgroundColor: colors.card, borderColor: colors.border }]}
                        nestedScrollEnabled
                      >
                        {(products ?? []).filter((product) => !alreadyUsed.has(product.id)).map((product) => (
                          <Pressable
                            key={product.id}
                            testID={`warehouse-transfer-product-${line.id}-${product.id}`}
                            style={[styles.dropdownItem, { borderBottomColor: colors.border }]}
                            onPress={() => {
                              updateLine(line.id, { productId: product.id });
                              setProductPickerOpen(null);
                            }}
                          >
                            <Text style={[styles.dropdownText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>
                              {product.name}
                            </Text>
                            <Text style={[styles.availableText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                              {(stockByProduct.get(product.id) ?? 0).toFixed(3)} {product.unit ?? ''}
                            </Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    )}
                    <View style={styles.quantityRow}>
                      <View style={styles.quantityField}>
                        <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>QUANTITY</Text>
                        <TextInput
                          testID={`warehouse-transfer-quantity-${line.id}`}
                          style={[styles.quantityInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
                          value={line.quantity}
                          onChangeText={(quantity) => updateLine(line.id, { quantity })}
                          placeholder="0.000"
                          placeholderTextColor={colors.mutedForeground}
                          keyboardType="decimal-pad"
                        />
                      </View>
                      <View style={styles.availableField}>
                        <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>AVAILABLE</Text>
                        <Text style={[styles.availableValue, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                          {available == null ? '—' : `${available.toFixed(3)}${selectedProduct?.unit ? ` ${selectedProduct.unit}` : ''}`}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}

              <Pressable
                testID="warehouse-transfer-submit"
                style={({ pressed }) => [
                  styles.submitButton,
                  { backgroundColor: colors.primary },
                  pressed && { opacity: 0.84 },
                  isPending && { opacity: 0.6 },
                ]}
                onPress={handleTransfer}
                disabled={isPending}
              >
                <Feather name="truck" size={17} color={colors.primaryForeground} />
                <Text style={[styles.submitText, { color: colors.primaryForeground, fontFamily: 'Inter_700Bold' }]}>
                  {isPending ? 'Recording transfer…' : 'Record transfer'}
                </Text>
              </Pressable>
            </View>
          )}

          <View style={styles.stockHeader}>
            <View>
              <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>On hand</Text>
              <Text style={[styles.helperText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {selectedWarehouse.name}
              </Text>
            </View>
            <Pressable
              testID="warehouse-stock-refresh"
              accessibilityLabel="Refresh warehouse stock"
              onPress={() => { void refetchStock(); }}
              disabled={isRefetching}
              style={styles.refreshButton}
            >
              <Feather name="refresh-cw" size={17} color={colors.primary} />
            </Pressable>
          </View>

          {loadingStock ? (
            <LoadingState message="Loading stock…" />
          ) : sortedStock.length === 0 ? (
            <View style={[styles.emptyStock, { borderColor: colors.border }]}>
              <Feather name="inbox" size={20} color={colors.mutedForeground} />
              <Text style={[styles.emptyStockText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                No stock recorded for this warehouse yet.
              </Text>
            </View>
          ) : sortedStock.map((line) => {
            const product = productById.get(line.productId);
            return (
              <View
                key={line.productId}
                testID={`warehouse-stock-product-${line.productId}`}
                style={[styles.stockCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={[styles.stockIcon, { backgroundColor: colors.info + '18' }]}>
                  <Feather name="droplet" size={16} color={colors.info} />
                </View>
                <View style={styles.stockCopy}>
                  <Text style={[styles.stockName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]} numberOfLines={1}>
                    {product?.name ?? `Product #${line.productId}`}
                  </Text>
                  <Text style={[styles.stockUnit, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                    {product?.unit ?? 'units'}
                  </Text>
                </View>
                <Text style={[styles.stockQuantity, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                  {Number(line.quantity).toFixed(3)}
                </Text>
              </View>
            );
          })}
        </>
      )}
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 10, gap: 12 },
  introCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1, borderRadius: 14 },
  introIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  introCopy: { flex: 1, gap: 3 },
  introTitle: { fontSize: 15 },
  introText: { fontSize: 12, lineHeight: 17 },
  sectionLabel: { fontSize: 11, letterSpacing: 0.6, marginTop: 4 },
  chipRow: { gap: 8, paddingBottom: 2 },
  warehouseChip: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 18, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 9, maxWidth: 240 },
  chipText: { fontSize: 13 },
  actionRow: { flexDirection: 'row', gap: 9, marginTop: 3 },
  secondaryAction: { flex: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12, borderWidth: 1, paddingHorizontal: 8 },
  primaryAction: { flex: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12, borderWidth: 1, paddingHorizontal: 8 },
  actionText: { fontSize: 13 },
  transferCard: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 10, marginTop: 2 },
  transferTitle: { fontSize: 17 },
  helperText: { fontSize: 12, lineHeight: 17 },
  fieldLabel: { fontSize: 11, letterSpacing: 0.4, marginBottom: 5 },
  picker: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 10, borderWidth: 1, paddingHorizontal: 11 },
  productPicker: { marginBottom: 7 },
  pickerText: { flex: 1, fontSize: 14 },
  dropdown: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  dropdownItem: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 11, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  dropdownText: { fontSize: 14 },
  emptyPicker: { padding: 12, fontSize: 13 },
  linesHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 5 },
  addLineButton: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  addLineText: { fontSize: 12 },
  lineCard: { borderWidth: 1, borderRadius: 11, padding: 10, marginBottom: 2 },
  lineHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  lineTitle: { fontSize: 13 },
  productDropdown: { maxHeight: 170, borderWidth: 1, borderRadius: 9, marginBottom: 8, overflow: 'hidden' },
  availableText: { fontSize: 11 },
  quantityRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  quantityField: { flex: 1 },
  availableField: { flex: 1, paddingBottom: 12 },
  quantityInput: { minHeight: 42, borderRadius: 9, borderWidth: 1, paddingHorizontal: 10, fontSize: 14 },
  availableValue: { minHeight: 42, paddingVertical: 12, fontSize: 14 },
  submitButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 12, marginTop: 4 },
  submitText: { fontSize: 14 },
  stockHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, marginBottom: 1 },
  sectionTitle: { fontSize: 19 },
  refreshButton: { padding: 10 },
  emptyStock: { minHeight: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', padding: 14 },
  emptyStockText: { fontSize: 13 },
  stockCard: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 11, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  stockIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stockCopy: { flex: 1, gap: 3 },
  stockName: { fontSize: 14 },
  stockUnit: { fontSize: 11 },
  stockQuantity: { fontSize: 14 },
});