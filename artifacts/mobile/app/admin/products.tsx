import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable, TextInput, Alert, Modal, ScrollView, Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useListProducts, useCreateProduct, useUpdateProduct, useDeleteProduct, useListCategories } from '@workspace/api-client-react';
import type { Product } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';

interface ProductForm {
  name: string; unit: string; categoryId: number | null; productNumber: string;
  minQuantity: string; maxQuantity: string; unitCost: string; isActive: boolean;
  description: string;
}
const BLANK: ProductForm = { name: '', unit: '', categoryId: null, productNumber: '', minQuantity: '', maxQuantity: '', unitCost: '', isActive: true, description: '' };

export default function AdminProductsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [modalVisible, setModalVisible] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductForm>(BLANK);
  const [search, setSearch] = useState('');
  const [showCatPicker, setShowCatPicker] = useState(false);

  const { data: products, isLoading, refetch } = useListProducts();
  const { data: categories } = useListCategories();
  const { mutateAsync: create, isPending: creating } = useCreateProduct();
  const { mutateAsync: update, isPending: updating } = useUpdateProduct();
  const { mutateAsync: deleteProduct } = useDeleteProduct();

  const catMap = Object.fromEntries((categories ?? []).map((c) => [c.id, c.name]));
  const selectedCatName = form.categoryId ? catMap[form.categoryId] : null;

  const filtered = (products ?? []).filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.productNumber ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const openCreate = () => { setEditingProduct(null); setForm(BLANK); setModalVisible(true); };
  const openEdit = (p: Product) => {
    setEditingProduct(p);
    setForm({ name: p.name, unit: p.unit ?? '', categoryId: p.categoryId ?? null, productNumber: p.productNumber ?? '', minQuantity: p.minLevel ?? '', maxQuantity: p.maxLevel ?? '', unitCost: p.cost ?? '', isActive: p.isActive, description: p.description ?? '' });
    setModalVisible(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { Alert.alert('Name required'); return; }
    const payload = {
      name: form.name, unit: form.unit || undefined, categoryId: form.categoryId ?? undefined,
      productNumber: form.productNumber || undefined, minLevel: form.minQuantity || undefined,
      maxLevel: form.maxQuantity || undefined, cost: form.unitCost || undefined,
      isActive: form.isActive, description: form.description || undefined,
    };
    try {
      if (editingProduct) { await update({ id: editingProduct.id, data: payload }); }
      else { await create({ data: payload }); }
      setModalVisible(false);
      refetch();
    } catch { Alert.alert('Error', 'Failed to save product.'); }
  };

  const handleDelete = (p: Product) => {
    Alert.alert(`Delete "${p.name}"?`, 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await deleteProduct({ id: p.id }); refetch(); } catch { Alert.alert('Error', 'Cannot delete — may be in use.'); } } },
    ]);
  };

  if (isLoading) return <LoadingState />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.searchBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Feather name="search" size={16} color={colors.mutedForeground} />
        <TextInput
          style={[styles.searchInput, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
          placeholder="Search products…"
          placeholderTextColor={colors.mutedForeground}
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && <Pressable onPress={() => setSearch('')}><Feather name="x" size={15} color={colors.mutedForeground} /></Pressable>}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.dot, { backgroundColor: item.isActive ? colors.success : colors.mutedForeground }]} />
            <View style={styles.cardBody}>
              <Text style={[styles.name, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>{item.name}</Text>
              <Text style={[styles.sub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {item.unit ?? '—'}{item.categoryId ? ` · ${catMap[item.categoryId] ?? '?'}` : ''}
                {item.productNumber ? ` · #${item.productNumber}` : ''}
              </Text>
            </View>
            <Pressable style={styles.iconBtn} onPress={() => openEdit(item)}>
              <Feather name="edit-2" size={15} color={colors.primary} />
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => handleDelete(item)}>
              <Feather name="trash-2" size={15} color={colors.destructive} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={<EmptyState icon="package" title="No products" action={{ label: 'Add Product', onPress: openCreate }} />}
        showsVerticalScrollIndicator={false}
      />
      <Pressable style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 24 }]} onPress={openCreate}>
        <Feather name="plus" size={24} color="#fff" />
      </Pressable>

      <Modal visible={modalVisible} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              {editingProduct ? 'Edit Product' : 'New Product'}
            </Text>
            <Pressable onPress={() => setModalVisible(false)}><Feather name="x" size={22} color={colors.foreground} /></Pressable>
          </View>
          <ScrollView style={{ padding: 20 }} keyboardShouldPersistTaps="handled">
            {[
              { label: 'Product Name *', key: 'name' as const, placeholder: 'e.g. Blue Rinse Concentrate' },
              { label: 'Product Number', key: 'productNumber' as const, placeholder: 'SKU or catalog #' },
              { label: 'Unit', key: 'unit' as const, placeholder: 'e.g. gallon, liter, kg' },
              { label: 'Min Quantity', key: 'minQuantity' as const, placeholder: '0', numeric: true },
              { label: 'Max Quantity', key: 'maxQuantity' as const, placeholder: '0', numeric: true },
              { label: 'Unit Cost ($)', key: 'unitCost' as const, placeholder: '0.00', numeric: true },
              { label: 'Description', key: 'description' as const, placeholder: 'Optional notes' },
            ].map((f) => (
              <View key={f.key} style={styles.formField}>
                <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>{f.label}</Text>
                <TextInput
                  style={[styles.formInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
                  value={(form as any)[f.key]}
                  onChangeText={(v) => setForm((p) => ({ ...p, [f.key]: v }))}
                  placeholder={f.placeholder}
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType={f.numeric ? 'decimal-pad' : 'default'}
                />
              </View>
            ))}

            {/* Category */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>Category</Text>
              <Pressable style={[styles.formInput, styles.pickerRow, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => setShowCatPicker(!showCatPicker)}>
                <Text style={[{ color: selectedCatName ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular', flex: 1, fontSize: 15 }]}>
                  {selectedCatName ?? 'No category'}
                </Text>
                <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
              </Pressable>
              {showCatPicker && (
                <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Pressable style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setForm((p) => ({ ...p, categoryId: null })); setShowCatPicker(false); }}>
                    <Text style={[{ color: colors.foreground, fontFamily: 'Inter_400Regular', fontSize: 14 }]}>No category</Text>
                  </Pressable>
                  {(categories ?? []).map((c) => (
                    <Pressable key={c.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setForm((p) => ({ ...p, categoryId: c.id })); setShowCatPicker(false); }}>
                      <Text style={[{ color: colors.foreground, fontFamily: 'Inter_400Regular', fontSize: 14 }]}>{c.name}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {editingProduct && (
              <View style={styles.switchRow}>
                <Text style={[styles.formLabel, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}>Active</Text>
                <Switch value={form.isActive} onValueChange={(v) => setForm((p) => ({ ...p, isActive: v }))} trackColor={{ true: colors.primary }} />
              </View>
            )}

            <Pressable style={[styles.saveBtn, { backgroundColor: colors.primary, marginBottom: 40 }]} onPress={handleSave} disabled={creating || updating}>
              <Text style={[styles.saveBtnText, { fontFamily: 'Inter_700Bold' }]}>{creating || updating ? 'Saving…' : 'Save Product'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, fontSize: 15 },
  list: { padding: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardBody: { flex: 1 },
  name: { fontSize: 15 },
  sub: { fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 8 },
  fab: { position: 'absolute', right: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4, boxShadow: '0 2px 6px rgba(0,0,0,0.2)' },
  modal: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: StyleSheet.hairlineWidth },
  modalTitle: { fontSize: 18 },
  formField: { gap: 6, marginBottom: 14 },
  formLabel: { fontSize: 13 },
  formInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 15 },
  pickerRow: { flexDirection: 'row', alignItems: 'center' },
  dropdown: { borderRadius: 10, borderWidth: 1, marginTop: 4, overflow: 'hidden' },
  dropdownItem: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, marginBottom: 14 },
  saveBtn: { borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  saveBtnText: { color: '#fff', fontSize: 16 },
});
