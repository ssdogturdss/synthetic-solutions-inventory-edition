/**
 * Tests for the undo toast in the inventory session screen.
 *
 * Covered cases:
 * 1. Quick-add scan shows the undo toast (with the product name).
 * 2. Tapping "Undo" after a quick-add scan on a product with NO prior count
 *    removes the entry entirely (fullContainers goes back to undefined/empty).
 * 3. Tapping "Undo" after a quick-add scan on a product WITH a prior count
 *    reverts fullContainers to its previous value.
 * 4. "Add 1 More" (normal-mode alert) path also shows the undo toast and
 *    reverts the count on tap.
 * 5. The toast auto-dismisses after 5 s and does NOT revert the count.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that transitively uses them
// ---------------------------------------------------------------------------

jest.mock('@expo-google-fonts/inter', () => ({
  useFonts: () => [true],
  Inter_400Regular: null,
  Inter_500Medium: null,
  Inter_600SemiBold: null,
  Inter_700Bold: null,
}));

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Medium: 'Medium' },
  NotificationFeedbackType: { Success: 'Success' },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text testID={`icon-${name}`}>{name}</Text>,
  };
});

// Capture the onScanned callback so tests can fire virtual scans.
let capturedOnScanned: ((code: string) => void) | null = null;

jest.mock('@/components/BarcodeScannerSheet', () => {
  const React = require('react');
  return {
    BarcodeScannerSheet: ({
      onScanned,
    }: {
      visible: boolean;
      onClose: () => void;
      onScanned: (code: string) => void;
    }) => {
      capturedOnScanned = onScanned;
      return null;
    },
  };
});

jest.mock('@/components/LoadingState', () => {
  const { Text } = require('react-native');
  return {
    LoadingState: ({ message }: { message: string }) => <Text>{message}</Text>,
  };
});

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    background: '#fff',
    foreground: '#000',
    card: '#f9f9f9',
    border: '#e0e0e0',
    primary: '#1a73e8',
    secondary: '#f1f3f4',
    mutedForeground: '#888',
    success: '#34a853',
    warning: '#fbbc04',
    radius: 8,
  }),
}));

// ---------------------------------------------------------------------------
// API-client mock — controllable per-test via module-level variables
// ---------------------------------------------------------------------------

type MockSession = {
  id: number;
  status: string;
  items: Array<{
    productId: number;
    fullContainers: number;
    partialContainers: number;
    estimatedPercentage: string | null;
    comments: string | null;
  }>;
  previousItems?: Array<{ productId: number; fullContainers: number; estimatedGallons?: string }>;
  usageSummary?: Array<{ productId: number; productName: string; usage: string }>;
};

let mockSession: MockSession | undefined;
let mockProducts: Array<{ id: number; name: string; unit?: string; productNumber?: string }> = [];
const mockSaveItems = jest.fn().mockResolvedValue([]);
const mockFinalize = jest.fn().mockResolvedValue({});
const mockRefetch = jest.fn();

jest.mock('@workspace/api-client-react', () => ({
  useGetInventorySession: () => ({
    data: mockSession,
    isLoading: false,
    refetch: mockRefetch,
  }),
  useListProducts: () => ({
    data: mockProducts,
    isLoading: false,
  }),
  useUpsertInventorySessionItems: () => ({
    mutateAsync: mockSaveItems,
    isPending: false,
  }),
  useFinalizeInventorySession: () => ({
    mutateAsync: mockFinalize,
    isPending: false,
  }),
  useAdminEditInventorySessionItems: () => ({
    mutateAsync: jest.fn().mockResolvedValue({}),
    isPending: false,
  }),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'staff' } }),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useNavigation: () => ({ setOptions: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Component under test
// ---------------------------------------------------------------------------

import InventorySessionScreen from '../app/inventory/[id]';

// ---------------------------------------------------------------------------
// Helpers & constants
// ---------------------------------------------------------------------------

const PRODUCT_A = { id: 42, name: 'Bleach 1-gal', unit: 'gallon', productNumber: 'BL-001' };
const PRODUCT_B = { id: 99, name: 'Mop Bucket', unit: 'each', productNumber: 'MB-002' };

function renderScreen() {
  return render(<InventorySessionScreen />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inventory session — undo toast', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    capturedOnScanned = null;
    mockProducts = [PRODUCT_A, PRODUCT_B];
    mockSession = { id: 1, status: 'open', items: [] };
  });

  afterEach(() => {
    // Run all pending timers so they don't leak into the next test, then
    // restore real timers so waitFor / act work correctly in subsequent tests.
    act(() => { jest.runAllTimers(); });
    jest.useRealTimers();
  });

  // ── 1. Quick-add scan → toast appears ────────────────────────────────────

  describe('1. Toast appears after a quick-add scan', () => {
    it('shows the undo button (accessibilityLabel) after scanning with quick-add enabled', async () => {
      const utils = renderScreen();

      // Enable quick-add mode
      fireEvent.press(utils.getByText('+1'));

      // Fire a scan for PRODUCT_A
      act(() => { capturedOnScanned?.('BL-001'); });

      // The toast must render its "Undo last scan" accessible button
      await waitFor(() => {
        expect(utils.getByLabelText('Undo last scan')).toBeTruthy();
      });
    });

    it('shows the "Undo" button text after a quick-add scan', async () => {
      const utils = renderScreen();

      fireEvent.press(utils.getByText('+1'));
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        expect(utils.getByText('Undo')).toBeTruthy();
      });
    });
  });

  // ── 2. Undo reverts to zero (no prior count) ─────────────────────────────

  describe('2. Undo removes the entry when there was no prior count', () => {
    it('reverts fullContainers to empty after undo (no prior count path)', async () => {
      // Fresh session — product has no prior count
      mockSession = { id: 1, status: 'open', items: [] };
      const utils = renderScreen();

      fireEvent.press(utils.getByText('+1'));
      act(() => { capturedOnScanned?.('BL-001'); });

      // Count should be 1 and toast should appear
      await waitFor(() => {
        expect(utils.getByDisplayValue('1')).toBeTruthy();
        expect(utils.getByText('Undo')).toBeTruthy();
      });

      // Tap Undo
      fireEvent.press(utils.getByText('Undo'));

      // The count input should be empty (entry removed)
      await waitFor(() => {
        expect(utils.queryByDisplayValue('1')).toBeNull();
      });

      // Advance past the 180 ms fade-out animation so the toast unmounts
      act(() => { jest.advanceTimersByTime(300); });

      // Toast should be gone
      await waitFor(() => {
        expect(utils.queryByText('Undo')).toBeNull();
      });
    });
  });

  // ── 3. Undo reverts to previous count ────────────────────────────────────

  describe('3. Undo reverts to the previous count when one existed', () => {
    it('restores the pre-scan full count after undo (prior count path)', async () => {
      // Session already has count = 3 for PRODUCT_A
      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 3, partialContainers: 0, estimatedPercentage: null, comments: null }],
      };

      const utils = renderScreen();

      // Wait for pre-fill
      await waitFor(() => {
        expect(utils.getByDisplayValue('3')).toBeTruthy();
      });

      // Quick-add scan: 3 → 4
      fireEvent.press(utils.getByText('+1'));
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        expect(utils.getByDisplayValue('4')).toBeTruthy();
        expect(utils.getByText('Undo')).toBeTruthy();
      });

      // Tap Undo
      fireEvent.press(utils.getByText('Undo'));

      // Should revert to 3, not 0 or empty
      await waitFor(() => {
        expect(utils.getByDisplayValue('3')).toBeTruthy();
      });
      expect(utils.queryByDisplayValue('4')).toBeNull();
    });
  });

  // ── 4. "Add 1 More" path also shows toast and reverts ────────────────────

  describe('4. "Add 1 More" alert path shows toast and reverts on undo', () => {
    it('shows the undo toast after "Add 1 More" and reverts on tap', async () => {
      // Normal mode (quick-add OFF) + pre-existing count → shows an Alert
      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 5, partialContainers: 0, estimatedPercentage: null, comments: null }],
      };

      const utils = renderScreen();

      // Wait for pre-fill
      await waitFor(() => {
        expect(utils.getByDisplayValue('5')).toBeTruthy();
      });

      // Spy on Alert so we can call "Add 1 More"
      let alertButtons: any[] = [];
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
        alertButtons = buttons ?? [];
      });

      // Scan in normal mode — triggers the alert
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
        expect(alertButtons.length).toBeGreaterThan(0);
      });

      // Simulate the user pressing "Add 1 More"
      const addOneMore = alertButtons.find((b: any) => b.text === 'Add 1 More');
      expect(addOneMore).toBeDefined();

      act(() => { addOneMore.onPress(); });

      // Count should be 6 and toast should appear
      await waitFor(() => {
        expect(utils.getByDisplayValue('6')).toBeTruthy();
        expect(utils.getByText('Undo')).toBeTruthy();
      });

      // Tap Undo — should revert to 5
      fireEvent.press(utils.getByText('Undo'));

      await waitFor(() => {
        expect(utils.getByDisplayValue('5')).toBeTruthy();
      });
      expect(utils.queryByDisplayValue('6')).toBeNull();

      alertSpy.mockRestore();
    });
  });

  // ── 5. Toast auto-dismisses after 5 s without reverting ──────────────────

  describe('5. Toast auto-dismisses without reverting the count', () => {
    it('hides the toast after 5 s and leaves the count unchanged', async () => {
      const utils = renderScreen();

      fireEvent.press(utils.getByText('+1'));
      act(() => { capturedOnScanned?.('BL-001'); });

      // Count becomes 1 and toast appears
      await waitFor(() => {
        expect(utils.getByDisplayValue('1')).toBeTruthy();
        expect(utils.getByText('Undo')).toBeTruthy();
      });

      // Fast-forward past the 5 s auto-dismiss + 200 ms fade-out animation
      act(() => { jest.advanceTimersByTime(5200); });

      // Toast should be gone — count must still be 1 (not reverted)
      await waitFor(() => {
        expect(utils.queryByText('Undo')).toBeNull();
      });

      expect(utils.getByDisplayValue('1')).toBeTruthy();
    });

    it('showing a second scan resets the 5 s timer without reverting the first scan', async () => {
      const utils = renderScreen();

      fireEvent.press(utils.getByText('+1'));

      // First scan
      act(() => { capturedOnScanned?.('BL-001'); });
      await waitFor(() => {
        expect(utils.getByDisplayValue('1')).toBeTruthy();
        expect(utils.getByText('Undo')).toBeTruthy();
      });

      // Advance 3 s (not yet dismissed)
      act(() => { jest.advanceTimersByTime(3000); });

      // Second scan — resets the timer
      act(() => { capturedOnScanned?.('BL-001'); });
      await waitFor(() => {
        expect(utils.getByDisplayValue('2')).toBeTruthy();
        expect(utils.getByText('Undo')).toBeTruthy();
      });

      // Advance another 5.2 s from the second scan
      act(() => { jest.advanceTimersByTime(5200); });

      // Toast should now be gone; count is 2 (neither scan was reverted)
      await waitFor(() => {
        expect(utils.queryByText('Undo')).toBeNull();
      });

      expect(utils.getByDisplayValue('2')).toBeTruthy();
    });
  });
});
