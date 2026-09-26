import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, TextInput, Alert, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useListCategories, useCreateCategory, useUpdateCategory, useDeleteCategory } from '@workspace/api-client-react';
import type { Category } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';

interface CatForm { name: string; description: string; }
const BLANK: CatForm = { name: '', description: '' };

export default function AdminCategoriesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [modalVisible, setModalVisible] = useState(false);
  const [editingCat, setEditingCat] = useState<Category | null>(null);
  const [form, setForm] = useState<CatForm>(BLANK);

  const { data: categories, isLoading, refetch } = useListCategories();
  const { mutateAsync: create, isPending: creating } = useCreateCategory();
  const { mutateAsync: update, isPending: updating } = useUpdateCategory();
  const { mutateAsync: deleteCat } = useDeleteCategory();

  const openCreate = () => { setEditingCat(null); setForm(BLANK); setModalVisible(true); };
  const openEdit = (c: Category) => { setEditingCat(c); setForm({ name: c.name, description: c.description ?? '' }); setModalVisible(true); };

  const handleSave = async () => {
    if (!form.name.trim()) { Alert.alert('Name required'); return; }
    try {
      if (editingCat) { await update({ id: editingCat.id, data: { name: form.name, description: form.description || undefined } }); }
      else { await create({ data: { name: form.name, description: form.description || undefined } }); }
      setModalVisible(false);
      refetch();
    } catch { Alert.alert('Error', 'Failed to save category.'); }
  };

  const handleDelete = (c: Category) => {
    Alert.alert(`Delete "${c.name}"?`, 'Products in this category will be uncategorized.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await deleteCat({ id: c.id }); refetch(); } catch { Alert.alert('Error', 'Cannot delete.'); } } },
    ]);
  };

  if (isLoading) return <LoadingState />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <FlatList
        data={categories ?? []}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.icon, { backgroundColor: colors.primary + '18' }]}>
              <Feather name="tag" size={18} color={colors.primary} />
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.name, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>{item.name}</Text>
              {item.description && <Text style={[styles.sub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{item.description}</Text>}
            </View>
            <Pressable style={styles.iconBtn} onPress={() => openEdit(item)}>
              <Feather name="edit-2" size={15} color={colors.primary} />
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => handleDelete(item)}>
              <Feather name="trash-2" size={15} color={colors.destructive} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={<EmptyState icon="tag" title="No categories" subtitle="Group your products into categories" action={{ label: 'Add Category', onPress: openCreate }} />}
        showsVerticalScrollIndicator={false}
      />
      <Pressable style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 24 }]} onPress={openCreate}>
        <Feather name="plus" size={24} color="#fff" />
      </Pressable>

      <Modal visible={modalVisible} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              {editingCat ? 'Edit Category' : 'New Category'}
            </Text>
            <Pressable onPress={() => setModalVisible(false)}><Feather name="x" size={22} color={colors.foreground} /></Pressable>
          </View>
          <View style={styles.modalBody}>
            {[
              { label: 'Category Name *', key: 'name' as const, placeholder: 'e.g. Drying Agents', multiline: false },
              { label: 'Description', key: 'description' as const, placeholder: 'Optional description', multiline: true },
            ].map((f) => (
              <View key={f.key} style={styles.formField}>
                <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>{f.label}</Text>
                <TextInput
                  style={[styles.formInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular', ...(f.multiline ? { minHeight: 80, textAlignVertical: 'top' } : {}) }]}
                  value={(form as any)[f.key]}
                  onChangeText={(v) => setForm((p) => ({ ...p, [f.key]: v }))}
                  placeholder={f.placeholder}
                  placeholderTextColor={colors.mutedForeground}
                  multiline={f.multiline}
                />
              </View>
            ))}
            <Pressable style={[styles.saveBtn, { backgroundColor: colors.primary }]} onPress={handleSave} disabled={creating || updating}>
              <Text style={[styles.saveBtnText, { fontFamily: 'Inter_700Bold' }]}>{creating || updating ? 'Saving…' : 'Save Category'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1 },
  name: { fontSize: 15 },
  sub: { fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 8 },
  fab: { position: 'absolute', right: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4, boxShadow: '0 2px 6px rgba(0,0,0,0.2)' },
  modal: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: StyleSheet.hairlineWidth },
  modalTitle: { fontSize: 18 },
  modalBody: { padding: 20, gap: 16 },
  formField: { gap: 6 },
  formLabel: { fontSize: 13 },
  formInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 15 },
  saveBtn: { borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  saveBtnText: { color: '#fff', fontSize: 16 },
});
