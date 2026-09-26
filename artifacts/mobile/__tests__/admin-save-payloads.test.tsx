import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text testID={`icon-${name}`}>{name}</Text>,
  };
});

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    background: '#fff',
    foreground: '#000',
    card: '#f9f9f9',
    border: '#e0e0e0',
    primary: '#1a73e8',
    muted: '#f1f3f4',
    mutedForeground: '#888',
    success: '#34a853',
    warning: '#f59e0b',
    destructive: '#ef4444',
    accent: '#0a7',
  }),
}));

jest.mock('@/components/LoadingState', () => {
  const { Text } = require('react-native');
  return { LoadingState: () => <Text>Loading…</Text> };
});

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

jest.mock('@/components/PinKeypad', () => {
  const { Text, TextInput } = require('react-native');
  return {
    PinDots: ({ value }: { value: string }) => <Text>{value}</Text>,
    PinKeypad: ({ value, onChange }: { value: string; onChange: (nextValue: string) => void }) => (
      <TextInput testID="pin-input" value={value} onChangeText={onChange} />
    ),
  };
});

let mockStores: Array<{ id: number; name: string; storeNumber?: string; address?: string; phone?: string; isActive: boolean }> = [];
let mockUsers: Array<{ id: number; name: string; role: 'admin' | 'store_user'; storeId: number | null; isActive: boolean }> = [];
let mockWarehouses: Array<{ id: number; name: string; warehouseNumber: string; manager?: string | null; address?: string | null; phone?: string | null; isActive: boolean }> = [];
let mockRefetch: jest.Mock;
let mockCreateStore: jest.Mock;
let mockUpdateStore: jest.Mock;
let mockCreateUser: jest.Mock;
let mockUpdateUser: jest.Mock;
let mockCreateWarehouse: jest.Mock;
let mockUpdateWarehouse: jest.Mock;

jest.mock('@workspace/api-client-react', () => ({
  useListStores: () => ({ data: mockStores, isLoading: false, refetch: mockRefetch }),
  useListUsers: () => ({ data: mockUsers, isLoading: false, refetch: mockRefetch }),
  useListWarehouses: () => ({ data: mockWarehouses, isLoading: false, refetch: mockRefetch }),
  useCreateStore: () => ({ mutateAsync: mockCreateStore, isPending: false }),
  useUpdateStore: () => ({ mutateAsync: mockUpdateStore, isPending: false }),
  useCreateUser: () => ({ mutateAsync: mockCreateUser, isPending: false }),
  useUpdateUser: () => ({ mutateAsync: mockUpdateUser, isPending: false }),
  useCreateWarehouse: () => ({ mutateAsync: mockCreateWarehouse, isPending: false }),
  useUpdateWarehouse: () => ({ mutateAsync: mockUpdateWarehouse, isPending: false }),
  useDeleteStore: () => ({ mutateAsync: jest.fn() }),
  useDeleteUser: () => ({ mutateAsync: jest.fn() }),
  useDeleteWarehouse: () => ({ mutateAsync: jest.fn() }),
  useResetUserPin: () => ({ mutateAsync: jest.fn(), isPending: false }),
  getBaseUrl: () => '',
}));

import AdminStoresScreen from '../app/admin/stores';
import AdminUsersScreen from '../app/admin/users';
import AdminWarehousesScreen from '../app/admin/warehouses';

const storesFixture = [
  { id: 7, name: 'North Store', storeNumber: 'S-007', address: '7 North Rd', phone: '555-0007', isActive: true },
  { id: 8, name: 'South Store', storeNumber: 'S-008', address: '8 South Rd', phone: '555-0008', isActive: true },
];

function serverError(message: string) {
  return Object.assign(new Error('Request failed'), { data: { error: message } });
}

describe('admin store, user, and warehouse saves', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockStores = [];
    mockUsers = [];
    mockWarehouses = [];
    mockRefetch = jest.fn();
    mockCreateStore = jest.fn().mockResolvedValue({});
    mockUpdateStore = jest.fn().mockResolvedValue({});
    mockCreateUser = jest.fn().mockResolvedValue({});
    mockUpdateUser = jest.fn().mockResolvedValue({});
    mockCreateWarehouse = jest.fn().mockResolvedValue({});
    mockUpdateWarehouse = jest.fn().mockResolvedValue({});
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('sends the store name, number, address, and phone when creating a store', async () => {
    const screen = render(<AdminStoresScreen />);
    fireEvent.press(screen.getByText('Add Store'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Highway 9 Location'), '  Market Street  ');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. S001'), '  S-204  ');
    fireEvent.changeText(screen.getByPlaceholderText('123 Main St'), '  24 Market Rd  ');
    fireEvent.changeText(screen.getByPlaceholderText('(555) 000-0000'), '  555-0204  ');
    fireEvent.press(screen.getByText('Save Store'));

    await waitFor(() => expect(mockCreateStore).toHaveBeenCalledWith({
      data: {
        name: 'Market Street',
        storeNumber: 'S-204',
        address: '24 Market Rd',
        phone: '555-0204',
      },
    }));
  });

  it('sends every edited store field, including an inactive state', async () => {
    mockStores = [storesFixture[0]];
    const screen = render(<AdminStoresScreen />);
    fireEvent.press(screen.getByTestId('icon-edit-2'));
    fireEvent.changeText(screen.getByDisplayValue('North Store'), '  North Market  ');
    fireEvent.changeText(screen.getByDisplayValue('S-007'), '  S-700  ');
    fireEvent.changeText(screen.getByDisplayValue('7 North Rd'), '  700 North Rd  ');
    fireEvent.changeText(screen.getByDisplayValue('555-0007'), '  555-0700  ');
    fireEvent(screen.getByRole('switch'), 'valueChange', false);
    fireEvent.press(screen.getByText('Save Store'));

    await waitFor(() => expect(mockUpdateStore).toHaveBeenCalledWith({
      id: 7,
      data: {
        name: 'North Market',
        storeNumber: 'S-700',
        address: '700 North Rd',
        phone: '555-0700',
        isActive: false,
      },
    }));
  });

  it('shows the server message when a store save fails', async () => {
    mockCreateStore.mockRejectedValueOnce(serverError('Store number S-204 is already in use'));
    const screen = render(<AdminStoresScreen />);
    fireEvent.press(screen.getByText('Add Store'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Highway 9 Location'), 'Market Street');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. S001'), 'S-204');
    fireEvent.press(screen.getByText('Save Store'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      'Error',
      'Store number S-204 is already in use',
    ));
  });

  it('sends the selected role, PIN, and store assignment when creating a user', async () => {
    mockStores = storesFixture;
    const screen = render(<AdminUsersScreen />);
    fireEvent.press(screen.getByText('Add User'));
    fireEvent.changeText(screen.getByPlaceholderText('Employee name'), 'Taylor Staff');
    fireEvent.press(screen.getByText('Select store…'));
    fireEvent.press(screen.getByText('North Store'));
    fireEvent.changeText(screen.getByTestId('pin-input'), '1234');
    fireEvent.press(screen.getByText('Save User'));

    await waitFor(() => expect(mockCreateUser).toHaveBeenCalledWith({
      data: { name: 'Taylor Staff', role: 'store_user', pin: '1234', storeId: 7 },
    }));
  });

  it('sends an edited user store assignment and role', async () => {
    mockStores = storesFixture;
    mockUsers = [{ id: 42, name: 'Taylor Staff', role: 'store_user', storeId: 7, isActive: true }];
    const screen = render(<AdminUsersScreen />);
    fireEvent.press(screen.getByTestId('icon-edit-2'));
    fireEvent.press(screen.getByText('North Store'));
    fireEvent.press(screen.getByText('South Store'));
    fireEvent.press(screen.getByText('Save User'));

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledWith({
      id: 42,
      data: { name: 'Taylor Staff', role: 'store_user', storeId: 8 },
    }));
  });

  it('explicitly clears a user store assignment when changing the role to admin', async () => {
    mockStores = storesFixture;
    mockUsers = [{ id: 42, name: 'Taylor Staff', role: 'store_user', storeId: 7, isActive: true }];
    const screen = render(<AdminUsersScreen />);
    fireEvent.press(screen.getByTestId('icon-edit-2'));
    fireEvent.press(screen.getByText('Admin'));
    fireEvent.press(screen.getByText('Save User'));

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledWith({
      id: 42,
      data: { name: 'Taylor Staff', role: 'admin', storeId: null },
    }));
  });

  it('shows the server message when a user save fails', async () => {
    mockCreateUser.mockRejectedValueOnce(serverError('PIN must contain at least four digits'));
    mockStores = storesFixture;
    const screen = render(<AdminUsersScreen />);
    fireEvent.press(screen.getByText('Add User'));
    fireEvent.changeText(screen.getByPlaceholderText('Employee name'), 'Taylor Staff');
    fireEvent.changeText(screen.getByTestId('pin-input'), '1234');
    fireEvent.press(screen.getByText('Save User'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      'Error',
      'PIN must contain at least four digits',
    ));
  });

  it('sends name, number, manager, address, and phone when creating a warehouse', async () => {
    const screen = render(<AdminWarehousesScreen />);
    fireEvent.press(screen.getByText('Add RC Warehouse'));
    fireEvent.changeText(screen.getByDisplayValue('RC Warehouse'), '  Central Depot  ');
    fireEvent.changeText(screen.getByDisplayValue('WH-001'), '  WH-204  ');
    fireEvent.changeText(screen.getByPlaceholderText('Warehouse manager'), '  Jordan Lee  ');
    fireEvent.changeText(screen.getByPlaceholderText('123 Main St'), '  204 Depot Ave  ');
    fireEvent.changeText(screen.getByPlaceholderText('(555) 000-0000'), '  555-0204  ');
    fireEvent.press(screen.getByText('Save Warehouse'));

    await waitFor(() => expect(mockCreateWarehouse).toHaveBeenCalledWith({
      data: {
        name: 'Central Depot',
        warehouseNumber: 'WH-204',
        manager: 'Jordan Lee',
        address: '204 Depot Ave',
        phone: '555-0204',
      },
    }));
  });

  it('sends every edited warehouse field, including an inactive state', async () => {
    mockWarehouses = [{
      id: 24,
      name: 'Central Depot',
      warehouseNumber: 'WH-024',
      manager: 'Jordan Lee',
      address: '24 Depot Ave',
      phone: '555-0024',
      isActive: true,
    }];
    const screen = render(<AdminWarehousesScreen />);
    fireEvent.press(screen.getByTestId('icon-edit-2'));
    fireEvent.changeText(screen.getByDisplayValue('Central Depot'), '  North Depot  ');
    fireEvent.changeText(screen.getByDisplayValue('WH-024'), '  WH-025  ');
    fireEvent.changeText(screen.getByDisplayValue('Jordan Lee'), '  Avery Chen  ');
    fireEvent.changeText(screen.getByDisplayValue('24 Depot Ave'), '  25 Depot Ave  ');
    fireEvent.changeText(screen.getByDisplayValue('555-0024'), '  555-0025  ');
    fireEvent(screen.getByRole('switch'), 'valueChange', false);
    fireEvent.press(screen.getByText('Save Warehouse'));

    await waitFor(() => expect(mockUpdateWarehouse).toHaveBeenCalledWith({
      id: 24,
      data: {
        name: 'North Depot',
        warehouseNumber: 'WH-025',
        manager: 'Avery Chen',
        address: '25 Depot Ave',
        phone: '555-0025',
        isActive: false,
      },
    }));
  });

  it('shows the server message when a warehouse save fails', async () => {
    mockCreateWarehouse.mockRejectedValueOnce(serverError('Warehouse number WH-204 is already in use'));
    const screen = render(<AdminWarehousesScreen />);
    fireEvent.press(screen.getByText('Add RC Warehouse'));
    fireEvent.press(screen.getByText('Save Warehouse'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      'Error',
      'Warehouse number WH-204 is already in use',
    ));
  });
});