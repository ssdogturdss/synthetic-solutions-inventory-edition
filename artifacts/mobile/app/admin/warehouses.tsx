import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable, TextInput, Alert, Modal, Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  useListWarehouses,
  useCreateWarehouse,
  useUpdateWarehouse,
  useDeleteWarehouse,
} from '@workspace/api-client-react';
import type { Warehouse } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { getApiErrorMessage } from '@/lib/api-error';

interface WarehouseForm {
  name: string;
  warehouseNumber: string;
  manager: string;
  address: string;
  phone: string;
  isActive: boolean;
}

const BLANK: WarehouseForm = {
  name: 'RC Warehouse',
  warehouseNumber: 'WH-001',
  manager: '',
  address: '',
  phone: '',
  isActive: true,
};

export default function AdminWarehousesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [modalVisible, setModalVisible] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [form, setForm] = useState<WarehouseForm>(BLANK);

  const { data: warehouses, isLoading, refetch } = useListWarehouses();
  const { mutateAsync: create, isPending: creating } = useCreateWarehouse();
  const { mutateAsync: update, isPending: updating } = useUpdateWarehouse();
  const { mutateAsync: deleteWarehouse } = useDeleteWarehouse();

  const openCreate = () => {
    setEditingWarehouse(null);
    setForm(BLANK);
    setModalVisible(true);
  };

  const openEdit = (warehouse: Warehouse) => {
    setEditingWarehouse(warehouse);
    setForm({
      name: warehouse.name,
      warehouseNumber: warehouse.warehouseNumber,
      manager: warehouse.manager ?? '',
      address: warehouse.address ?? '',
      phone: warehouse.phone ?? '',
      isActive: warehouse.isActive,
    });
    setModalVisible(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.warehouseNumber.trim()) {
      Alert.alert('Name and number required');
      return;
    }

    try {
      const data = {
        name: form.name.trim(),
        warehouseNumber: form.warehouseNumber.trim(),
        manager: form.manager.trim() || undefined,
        address: form.address.trim() || undefined,
        phone: form.phone.trim() || undefined,
        ...(editingWarehouse ? { isActive: form.isActive } : {}),
      };

      if (editingWarehouse) {
        await update({ id: editingWarehouse.id, data });
      } else {
        await create({ data });
      }
      setModalVisible(false);
      refetch();
    } catch (error) {
      Alert.alert('Error', getApiErrorMessage(error, 'Failed to save warehouse.'));
    }
  };

  const handleDelete = (warehouse: Warehouse) => {
    const doDelete = async () => {
      try {
        await deleteWarehouse({ id: warehouse.id });
        setModalVisible(false);
        refetch();
      } catch {
        Alert.alert('Error', 'Cannot delete warehouse.');
      }
    };

    if (typeof window !== 'undefined' && typeof (window as any).confirm === 'function') {
      if ((window as any).confirm(`Delete "${warehouse.name}"? This cannot be undone.`)) doDelete();
    } else {
      Alert.alert(`Delete "${warehouse.name}"?`, 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  if (isLoading) return <LoadingState />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <FlatList
        data={warehouses ?? []}
        keyExtractor={(warehouse) => String(warehouse.id)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.icon, { backgroundColor: colors.primary + '18' }]}>
              <Feather name="home" size={19} color={colors.primary} />
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.name, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                {item.name}
              </Text>
              <Text style={[styles.sub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {item.warehouseNumber}{item.address ? ` · ${item.address}` : ''}
              </Text>
            </View>
            <View style={[styles.statusDot, { backgroundColor: item.isActive ? colors.success : colors.mutedForeground }]} />
            <Pressable style={styles.iconButton} onPress={() => openEdit(item)}>
              <Feather name="edit-2" size={16} color={colors.primary} />
            </Pressable>
            <Pressable style={styles.iconButton} onPress={() => handleDelete(item)}>
              <Feather name="trash-2" size={16} color={colors.destructive} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            icon="home"
            title="No warehouses"
            subtitle="Set up RC Warehouse to track your central inventory location"
            action={{ label: 'Add RC Warehouse', onPress: openCreate }}
          />
        }
        showsVerticalScrollIndicator={false}
      />
      <Pressable
        style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 24 }]}
        onPress={openCreate}
      >
        <Feather name="plus" size={24} color="#fff" />
      </Pressable>

      <Modal visible={modalVisible} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              {editingWarehouse ? 'Edit Warehouse' : 'New Warehouse'}
            </Text>
            <Pressable onPress={() => setModalVisible(false)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>
          <View style={styles.modalBody}>
            {[
              { label: 'Warehouse Name *', key: 'name' as const, placeholder: 'e.g. RC Warehouse' },
              { label: 'Warehouse Number *', key: 'warehouseNumber' as const, placeholder: 'e.g. WH-001' },
              { label: 'Manager', key: 'manager' as const, placeholder: 'Warehouse manager' },
              { label: 'Address', key: 'address' as const, placeholder: '123 Main St' },
              { label: 'Phone', key: 'phone' as const, placeholder: '(555) 000-0000' },
            ].map((field) => (
              <View key={field.key} style={styles.formField}>
                <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                  {field.label}
                </Text>
                <TextInput
                  style={[styles.formInput, {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    color: colors.foreground,
                    fontFamily: 'Inter_400Regular',
                  }]}
                  value={form[field.key]}
                  onChangeText={(value) => setForm((current) => ({ ...current, [field.key]: value }))}
                  placeholder={field.placeholder}
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
            ))}
            {editingWarehouse && (
              <View style={styles.switchRow}>
                <Text style={[styles.formLabel, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}>
                  Active
                </Text>
                <Switch
                  value={form.isActive}
                  onValueChange={(value) => setForm((current) => ({ ...current, isActive: value }))}
                  trackColor={{ true: colors.primary }}
                />
              </View>
            )}
            <Pressable
              style={[styles.saveButton, { backgroundColor: colors.primary }]}
              onPress={handleSave}
              disabled={creating || updating}
            >
              <Text style={[styles.saveText, { fontFamily: 'Inter_700Bold' }]}>
                {creating || updating ? 'Saving…' : 'Save Warehouse'}
              </Text>
            </Pressable>
            {editingWarehouse && (
              <Pressable
                style={[styles.deleteButton, { borderColor: colors.destructive }]}
                onPress={() => handleDelete(editingWarehouse)}
              >
                <Feather name="trash-2" size={15} color={colors.destructive} />
                <Text style={[styles.deleteText, { color: colors.destructive, fontFamily: 'Inter_600SemiBold' }]}>
                  Delete Warehouse
                </Text>
              </Pressable>
            )}
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
  icon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1 },
  name: { fontSize: 15 },
  sub: { fontSize: 12, marginTop: 3 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  iconButton: { padding: 8 },
  fab: { position: 'absolute', right: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4, boxShadow: '0 2px 6px rgba(0,0,0,0.2)' },
  modal: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: StyleSheet.hairlineWidth },
  modalTitle: { fontSize: 20, flex: 1, marginRight: 12 },
  modalBody: { padding: 20, gap: 16 },
  formField: { gap: 6 },
  formLabel: { fontSize: 13 },
  formInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  saveButton: { borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  saveText: { color: '#fff', fontSize: 16 },
  deleteButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, borderWidth: 1, padding: 14 },
  deleteText: { fontSize: 15 },
});