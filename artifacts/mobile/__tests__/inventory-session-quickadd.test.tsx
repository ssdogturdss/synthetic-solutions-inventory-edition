/**
 * Tests for the quick-add barcode scan behaviour in the inventory session screen.
 *
 * Covers:
 * 1. Pre-fill useEffect: server items populate local state on load.
 * 2. Quick-add scan on a pre-filled row: increments from the server-provided
 *    value (not from 0) after a save-and-reload cycle.
 * 3. Quick-add scan on a row with no prior count: starts from 0 and goes to 1.
 * 4. Normal-mode scan on a pre-filled row: does NOT auto-increment (shows alert).
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any import that uses them
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

// AsyncStorage is imported by the inventory screen; mock it out for these tests
// so the native module absence doesn't break the test suite.
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

// Capture the onScanned callback so tests can fire virtual scans without the
// native camera. The mock renders nothing (no camera overlay in test env).
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
// API-client mock — controllable per-test via setters
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
  usageSummary?: Array<{ productId: number; productName: string; usage: string }>;
};

let mockSession: MockSession | undefined;
let mockProducts: Array<{ id: number; name: string; unit?: string; productNumber?: string }> = [];
const mockSaveItems = jest.fn().mockResolvedValue([]);
const mockFinalize = jest.fn().mockResolvedValue({});
const mockRefetch = jest.fn();

jest.mock('@workspace/api-client-react', () => ({
  setAuthTokenGetter: jest.fn(),
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

// expo-router: supply a fixed session id param
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useNavigation: () => ({ setOptions: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Import the component under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import InventorySessionScreen from '../app/inventory/[id]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRODUCT_A = { id: 42, name: 'Bleach 1-gal', unit: 'gallon', productNumber: 'BL-001' };
const PRODUCT_B = { id: 99, name: 'Mop Bucket', unit: 'each', productNumber: 'MB-002' };

function renderScreen() {
  return render(<InventorySessionScreen />);
}

/** Find the "Full" TextInput for a given productId by its displayed value. */
function getFullInput(utils: ReturnType<typeof render>, value: string) {
  return utils.getByDisplayValue(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inventory session — quick-add scan behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScanned = null;
    mockProducts = [PRODUCT_A, PRODUCT_B];
    // Default: open session with no pre-saved items
    mockSession = { id: 1, status: 'open', items: [] };
  });

  afterEach(() => {
    // Clear any pending timers (undo toast 5 s, highlight 3 s, scroll 100 ms)
    // so they don't fire into a torn-down Jest environment.
    jest.clearAllTimers();
  });

  // ── 1. Pre-fill useEffect ───────────────────────────────────────────────

  describe('pre-fill useEffect', () => {
    it('populates the Full input from server session items on first render', async () => {
      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 3, partialContainers: 1, estimatedPercentage: null, comments: null }],
      };

      const utils = renderScreen();

      // The Full input for product 42 should show '3' after the effect runs
      await waitFor(() => {
        expect(getFullInput(utils, '3')).toBeTruthy();
      });
    });

    it('pre-fills multiple products independently', async () => {
      mockSession = {
        id: 1,
        status: 'open',
        items: [
          { productId: 42, fullContainers: 5, partialContainers: 0, estimatedPercentage: null, comments: null },
          { productId: 99, fullContainers: 2, partialContainers: 0, estimatedPercentage: null, comments: null },
        ],
      };

      const utils = renderScreen();

      await waitFor(() => {
        expect(getFullInput(utils, '5')).toBeTruthy();
        expect(getFullInput(utils, '2')).toBeTruthy();
      });
    });
  });

  // ── 2. Quick-add scan on a pre-filled row (core regression) ────────────

  describe('quick-add scan after save-and-reload', () => {
    it('increments from the server-provided value, not from 0', async () => {
      // Simulate: staff set fullContainers=3, saved, and reloaded the screen.
      // The server returns those items back; the pre-fill useEffect populates state.
      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 3, partialContainers: 0, estimatedPercentage: null, comments: null }],
      };

      const utils = renderScreen();

      // Wait for pre-fill to run
      await waitFor(() => {
        expect(getFullInput(utils, '3')).toBeTruthy();
      });

      // Enable quick-add mode
      fireEvent.press(utils.getByText('+1'));

      // Simulate a barcode scan for PRODUCT_A
      act(() => {
        capturedOnScanned?.('BL-001');
      });

      // The Full field should now show 4 (3 + 1), not 1 (0 + 1)
      await waitFor(() => {
        expect(getFullInput(utils, '4')).toBeTruthy();
      });
    });

    it('each subsequent quick-add scan on the same product keeps incrementing', async () => {
      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 3, partialContainers: 0, estimatedPercentage: null, comments: null }],
      };

      const utils = renderScreen();

      await waitFor(() => {
        expect(getFullInput(utils, '3')).toBeTruthy();
      });

      fireEvent.press(utils.getByText('+1'));

      // First scan: 3 → 4
      act(() => { capturedOnScanned?.('BL-001'); });
      await waitFor(() => { expect(getFullInput(utils, '4')).toBeTruthy(); });

      // Second scan: 4 → 5
      act(() => { capturedOnScanned?.('BL-001'); });
      await waitFor(() => { expect(getFullInput(utils, '5')).toBeTruthy(); });

      // Third scan: 5 → 6
      act(() => { capturedOnScanned?.('BL-001'); });
      await waitFor(() => { expect(getFullInput(utils, '6')).toBeTruthy(); });
    });

    it('increments independently for two different products', async () => {
      mockSession = {
        id: 1,
        status: 'open',
        items: [
          { productId: 42, fullContainers: 3, partialContainers: 0, estimatedPercentage: null, comments: null },
          { productId: 99, fullContainers: 7, partialContainers: 0, estimatedPercentage: null, comments: null },
        ],
      };

      const utils = renderScreen();

      await waitFor(() => {
        expect(getFullInput(utils, '3')).toBeTruthy();
        expect(getFullInput(utils, '7')).toBeTruthy();
      });

      fireEvent.press(utils.getByText('+1'));

      // Scan PRODUCT_A
      act(() => { capturedOnScanned?.('BL-001'); });
      await waitFor(() => { expect(getFullInput(utils, '4')).toBeTruthy(); });

      // PRODUCT_B unchanged
      expect(getFullInput(utils, '7')).toBeTruthy();

      // Scan PRODUCT_B
      act(() => { capturedOnScanned?.('MB-002'); });
      await waitFor(() => { expect(getFullInput(utils, '8')).toBeTruthy(); });

      // PRODUCT_A unchanged
      expect(getFullInput(utils, '4')).toBeTruthy();
    });
  });

  // ── 3. Quick-add on a product with no prior count ───────────────────────

  describe('quick-add scan on a row with no prior count', () => {
    it('starts from 0 and increments to 1', async () => {
      // No items pre-saved; session is fresh
      mockSession = { id: 1, status: 'open', items: [] };

      const utils = renderScreen();

      // Enable quick-add mode
      fireEvent.press(utils.getByText('+1'));

      // Scan PRODUCT_A (no prior count)
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        expect(getFullInput(utils, '1')).toBeTruthy();
      });
    });
  });

  // ── 4. Normal mode does NOT auto-increment pre-filled rows ──────────────

  describe('normal scan mode (not quick-add)', () => {
    it('shows an Alert (not an auto-increment) when scanning a pre-filled product', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert');

      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 3, partialContainers: 0, estimatedPercentage: null, comments: null }],
      };

      const utils = renderScreen();

      await waitFor(() => {
        expect(getFullInput(utils, '3')).toBeTruthy();
      });

      // Quick-add is OFF (default)
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        // Should prompt the user what to do, not silently increment
        expect(alertSpy).toHaveBeenCalledWith(
          PRODUCT_A.name,
          expect.stringContaining('Already counted'),
          expect.any(Array),
        );
      });

      // The count must NOT have changed to 4
      expect(utils.queryByDisplayValue('4')).toBeNull();
      expect(getFullInput(utils, '3')).toBeTruthy();
    });
  });
});
