import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import {
  getGetWarehouseStockQueryKey,
  getListReceivingRecordsQueryKey,
  getListWarehouseMovementsQueryKey,
  useListStores,
  useListWarehouses,
  useListProducts,
  useCreateReceivingRecord,
} from '@workspace/api-client-react';
import type { ReceivingItemInput } from '@workspace/api-client-react';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';

interface ReceivingLine {
  id: string;
  productId: number | null;
  qty: string;
  lot: string;
  cost: string;
  expiry: string;
}

export default function NewReceivingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const params = useLocalSearchParams<{ destination?: string }>();
  const queryClient = useQueryClient();

  const [storeId, setStoreId] = useState<number | null>(user?.storeId ?? null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [destination, setDestination] = useState<'store' | 'warehouse'>(
    params.destination === 'warehouse' ? 'warehouse' : 'store',
  );
  const [vendor, setVendor] = useState('');
  const [invoice, setInvoice] = useState('');
  const [po, setPo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<ReceivingLine[]>([{ id: '1', productId: null, qty: '', lot: '', cost: '', expiry: '' }]);
  const [showStorePicker, setShowStorePicker] = useState(false);
  const [showWarehousePicker, setShowWarehousePicker] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState<string | null>(null);

  const { data: stores } = useListStores();
  const { data: warehouses } = useListWarehouses();
  const { data: products } = useListProducts({ activeOnly: true });
  const { mutateAsync: createRecord, isPending } = useCreateReceivingRecord();

  const selectedStore = (stores ?? []).find((s) => s.id === storeId);
  const selectedWarehouse = (warehouses ?? []).find(
    (warehouse) => warehouse.id === warehouseId && warehouse.isActive && warehouse.status === 'active',
  );
  const isWarehouseDestination = isAdmin && destination === 'warehouse';

  const addLine = () => {
    setLines((prev) => [...prev, { id: `${Date.now()}`, productId: null, qty: '', lot: '', cost: '', expiry: '' }]);
  };

  const removeLine = (id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const updateLine = (id: string, field: keyof Omit<ReceivingLine, 'id'>, value: string | number | null) => {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, [field]: value } : l));
  };

  const handleSubmit = async () => {
    if (isWarehouseDestination && !selectedWarehouse) {
      Alert.alert('Select Warehouse', 'Please select the warehouse receiving this delivery.');
      return;
    }
    if (!isWarehouseDestination && !storeId) { Alert.alert('Select Store', 'Please select a store.'); return; }
    const validLines = lines.filter((l) => l.productId && l.qty && parseFloat(l.qty) > 0);
    if (validLines.length === 0) { Alert.alert('Add Items', 'Add at least one product with a quantity.'); return; }

    const items: ReceivingItemInput[] = validLines.map((l) => ({
      productId: l.productId!,
      quantityReceived: l.qty,
      lotNumber: l.lot || undefined,
      cost: l.cost || undefined,
      expirationDate: l.expiry || undefined,
    }));

    try {
      await createRecord({
        data: {
          ...(isWarehouseDestination ? { warehouseId: selectedWarehouse!.id } : { storeId: storeId! }),
          ...(!isWarehouseDestination && isAdmin && selectedWarehouse ? { warehouseId: selectedWarehouse.id } : {}),
          vendor: vendor || undefined,
          invoiceNumber: invoice || undefined,
          poNumber: po || undefined,
          notes: notes || undefined,
          items,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListReceivingRecordsQueryKey() });
      if (selectedWarehouse && isAdmin) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetWarehouseStockQueryKey(selectedWarehouse.id) }),
          queryClient.invalidateQueries({ queryKey: getListWarehouseMovementsQueryKey() }),
        ]);
      }
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      Alert.alert('Error', 'Failed to log delivery. Please try again.');
    }
  };

  const productMap = Object.fromEntries((products ?? []).map((p) => [p.id, p.name]));

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={72}
      >
        {isAdmin && (
          <>
            <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>RECEIVE INTO</Text>
            <View style={[styles.destinationToggle, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              {(['store', 'warehouse'] as const).map((target) => {
                const selected = destination === target;
                return (
                  <Pressable
                    key={target}
                    testID={`receiving-destination-${target}`}
                    style={[styles.destinationButton, selected && { backgroundColor: colors.card }]}
                    onPress={() => {
                      setDestination(target);
                      setWarehouseId(null);
                    }}
                  >
                    <Feather name={target === 'store' ? 'map-pin' : 'home'} size={15} color={selected ? colors.primary : colors.mutedForeground} />
                    <Text style={[styles.destinationText, { color: selected ? colors.foreground : colors.mutedForeground, fontFamily: selected ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>
                      {target === 'store' ? 'Store' : 'Warehouse'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        {!isWarehouseDestination && (
          <>
            <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>STORE</Text>
            {isAdmin ? (
              <>
                <Pressable style={[styles.picker, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => setShowStorePicker(!showStorePicker)}>
                  <Feather name="map-pin" size={16} color={colors.mutedForeground} />
                  <Text style={[styles.pickerText, { color: selectedStore ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                    {selectedStore?.name ?? 'Select store…'}
                  </Text>
                  <Feather name={showStorePicker ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
                </Pressable>
                {showStorePicker && (
                  <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    {(stores ?? []).filter((s) => s.isActive).map((s) => (
                      <Pressable key={s.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setStoreId(s.id); setShowStorePicker(false); }}>
                        <Text style={[styles.dropdownText, { color: s.id === storeId ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>{s.name}</Text>
                        {s.id === storeId && <Feather name="check" size={16} color={colors.primary} />}
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            ) : (
              <View style={[styles.picker, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <Feather name="map-pin" size={16} color={colors.mutedForeground} />
                <Text style={[styles.pickerText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>{selectedStore?.name ?? 'Your store'}</Text>
              </View>
            )}
          </>
        )}

        {(isWarehouseDestination || (isAdmin && destination === 'store')) && (
          <>
            <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>
              {isWarehouseDestination ? 'WAREHOUSE' : 'WAREHOUSE (OPTIONAL)'}
            </Text>
            <Pressable
              style={[styles.picker, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => setShowWarehousePicker(!showWarehousePicker)}
            >
              <Feather name="home" size={16} color={colors.mutedForeground} />
              <Text style={[styles.pickerText, { color: selectedWarehouse ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {selectedWarehouse?.name ?? (isWarehouseDestination ? 'Select warehouse…' : 'No warehouse selected')}
              </Text>
              <Feather name={showWarehousePicker ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
            </Pressable>
            {showWarehousePicker && (
              <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {!isWarehouseDestination && (
                  <Pressable style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setWarehouseId(null); setShowWarehousePicker(false); }}>
                    <Text style={[styles.dropdownText, { color: !selectedWarehouse ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>No warehouse selected</Text>
                    {!selectedWarehouse && <Feather name="check" size={16} color={colors.primary} />}
                  </Pressable>
                )}
                {(warehouses ?? []).filter((w) => w.isActive && w.status === 'active').map((w) => (
                  <Pressable key={w.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setWarehouseId(w.id); setShowWarehousePicker(false); }}>
                    <Text style={[styles.dropdownText, { color: w.id === warehouseId ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>{w.name}</Text>
                    {w.id === warehouseId && <Feather name="check" size={16} color={colors.primary} />}
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}

        {/* Header fields */}
        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>DELIVERY INFO</Text>
        {[
          { label: 'Vendor / Supplier', value: vendor, set: setVendor, placeholder: 'e.g. ChemCo Supply' },
          { label: 'Invoice #', value: invoice, set: setInvoice, placeholder: 'Optional' },
          { label: 'PO Number', value: po, set: setPo, placeholder: 'Optional' },
        ].map((f) => (
          <View key={f.label} style={styles.fieldRow}>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{f.label}</Text>
            <TextInput
              style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
              value={f.value}
              onChangeText={f.set}
              placeholder={f.placeholder}
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
        ))}

        {/* Line items */}
        <View style={styles.lineHeader}>
          <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20, flex: 1 }]}>ITEMS</Text>
          <Pressable onPress={addLine} style={[styles.addLineBtn, { backgroundColor: colors.primary + '18' }]}>
            <Feather name="plus" size={14} color={colors.primary} />
            <Text style={[styles.addLineText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>Add</Text>
          </Pressable>
        </View>

        {lines.map((line, idx) => (
          <View key={line.id} style={[styles.lineCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.lineCardHeader}>
              <Text style={[styles.lineNum, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>Item {idx + 1}</Text>
              {lines.length > 1 && (
                <Pressable onPress={() => removeLine(line.id)}>
                  <Feather name="trash-2" size={16} color={colors.destructive} />
                </Pressable>
              )}
            </View>

            {/* Product picker */}
            <Pressable
              style={[styles.picker, { backgroundColor: colors.background, borderColor: colors.border }]}
              onPress={() => setShowProductPicker(showProductPicker === line.id ? null : line.id)}
            >
              <Feather name="package" size={14} color={colors.mutedForeground} />
              <Text style={[styles.pickerText, { color: line.productId ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {line.productId ? productMap[line.productId] ?? 'Unknown' : 'Select product…'}
              </Text>
            </Pressable>
            {showProductPicker === line.id && (
              <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border, maxHeight: 160 }]}>
                <ScrollView nestedScrollEnabled>
                  {(products ?? []).map((p) => (
                    <Pressable key={p.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { updateLine(line.id, 'productId', p.id); setShowProductPicker(null); }}>
                      <Text style={[styles.dropdownText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>{p.name}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}

            <View style={styles.lineFields}>
              {[
                { label: 'Qty', field: 'qty' as const, placeholder: '0', keyboard: 'decimal-pad' as const },
                { label: 'Lot #', field: 'lot' as const, placeholder: 'Optional', keyboard: 'default' as const },
              ].map((f) => (
                <View key={f.field} style={styles.halfField}>
                  <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{f.label}</Text>
                  <TextInput
                    style={[styles.fieldInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
                    value={(line as any)[f.field]}
                    onChangeText={(v) => updateLine(line.id, f.field, v)}
                    placeholder={f.placeholder}
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType={f.keyboard}
                  />
                </View>
              ))}
            </View>
          </View>
        ))}

        <Pressable
          style={({ pressed }) => [styles.submitBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }, isPending && { opacity: 0.7 }]}
          onPress={handleSubmit}
          disabled={isPending}
        >
          <Feather name="package" size={18} color="#fff" />
          <Text style={[styles.submitText, { fontFamily: 'Inter_700Bold' }]}>{isPending ? 'Logging…' : 'Log Delivery'}</Text>
        </Pressable>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 20 },
  label: { fontSize: 12, letterSpacing: 0.6, marginBottom: 8 },
  destinationToggle: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, padding: 4, marginBottom: 18 },
  destinationButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 9, paddingVertical: 10 },
  destinationText: { fontSize: 13 },
  picker: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 8 },
  pickerText: { flex: 1, fontSize: 14 },
  dropdown: { borderRadius: 12, borderWidth: 1, marginBottom: 8, overflow: 'hidden' },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  dropdownText: { fontSize: 14 },
  fieldRow: { marginBottom: 10 },
  fieldLabel: { fontSize: 12, marginBottom: 4 },
  fieldInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 14 },
  lineHeader: { flexDirection: 'row', alignItems: 'center', marginTop: 20 },
  addLineBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginTop: 8 },
  addLineText: { fontSize: 13 },
  lineCard: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 12 },
  lineCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  lineNum: { fontSize: 13 },
  lineFields: { flexDirection: 'row', gap: 10, marginTop: 8 },
  halfField: { flex: 1 },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 14, padding: 18, marginTop: 16 },
  submitText: { color: '#fff', fontSize: 17 },
});
