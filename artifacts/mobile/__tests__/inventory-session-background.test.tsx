/**
 * Tests confirming that unsaved scan counts survive the app being backgrounded
 * (or killed and relaunched) mid-session.
 *
 * Strategy:
 *   - After each scan / updateItem call the component writes the current items
 *     map to AsyncStorage under the key `inventory-draft-<sessionId>`.
 *   - On mount the component reads that key; if a draft is found it restores
 *     the items into state before the server pre-fill effect has a chance to
 *     overwrite them.
 *   - After a successful server save the draft is deleted so a future mount
 *     starts from the server-authoritative data.
 *
 * Covered cases:
 *   1. A single quick-add scan writes the updated count to AsyncStorage.
 *   2. Multiple quick-add scans accumulate correctly and the final AsyncStorage
 *      value reflects all of them.
 *   3. Mounting the screen with a stored draft restores items (simulates the
 *      app being killed while backgrounded and then relaunched).
 *   4. A draft takes precedence over a stale server pre-fill when both are
 *      present simultaneously.
 *   5. A successful "Save Draft" clears the AsyncStorage draft.
 *   6. A corrupt / unparseable draft is ignored and the server data is used.
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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text testID={`icon-${name}`}>{name}</Text>,
  };
});

// Capture the onScanned callback so tests can fire virtual scans without a
// real camera.
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
// AsyncStorage mock — in-memory store, inspectable via the jest functions
// ---------------------------------------------------------------------------

const asyncStorageStore: Record<string, string> = {};

const mockSetItem = jest.fn(async (key: string, value: string) => {
  asyncStorageStore[key] = value;
});
const mockGetItem = jest.fn(async (key: string) => asyncStorageStore[key] ?? null);
const mockRemoveItem = jest.fn(async (key: string) => {
  delete asyncStorageStore[key];
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => mockGetItem(key),
    setItem: (key: string, value: string) => mockSetItem(key, value),
    removeItem: (key: string) => mockRemoveItem(key),
  },
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

// expo-router: supply a fixed session id param (id = '1')
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useNavigation: () => ({
    setOptions: jest.fn(),
    // Required by the beforeRemove unsaved-counts guard; returns an unsubscribe fn.
    addListener: jest.fn(() => jest.fn()),
    dispatch: jest.fn(),
  }),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'staff' } }),
}));

// ---------------------------------------------------------------------------
// Import the component under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import InventorySessionScreen from '../app/inventory/[id]';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const PRODUCT_A = { id: 42, name: 'Bleach 1-gal', unit: 'gallon', productNumber: 'BL-001' };
const PRODUCT_B = { id: 99, name: 'Mop Bucket', unit: 'each', productNumber: 'MB-002' };

const DRAFT_KEY = 'inventory-draft-1';

function renderScreen() {
  return render(<InventorySessionScreen />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inventory session — background persistence via AsyncStorage draft', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScanned = null;
    mockProducts = [PRODUCT_A, PRODUCT_B];
    mockSession = { id: 1, status: 'open', items: [] };

    // Clear the in-memory store
    for (const k of Object.keys(asyncStorageStore)) delete asyncStorageStore[k];
  });

  afterEach(() => {
    // Clear any timers (undo toast, highlight, scroll) that would otherwise
    // fire after Jest tears down the React environment and cause teardown errors.
    jest.clearAllTimers();
  });

  // ── 1. Single scan writes to AsyncStorage ─────────────────────────────

  describe('1. AsyncStorage is written after each scan', () => {
    it('writes the updated count to AsyncStorage after one quick-add scan', async () => {
      const utils = renderScreen();

      // Wait for draft check to resolve (getItem resolves to null)
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      // Enable quick-add mode
      fireEvent.press(utils.getByText('+1'));

      // Scan PRODUCT_A
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        expect(mockSetItem).toHaveBeenCalledWith(
          DRAFT_KEY,
          expect.stringContaining('"42"') // productId 42 is a key
        );
      });

      // Verify the stored value has the correct count
      const storedRaw = asyncStorageStore[DRAFT_KEY];
      expect(storedRaw).toBeDefined();
      const stored = JSON.parse(storedRaw);
      expect(stored[42]?.full).toBe('1');
    });

    it('accumulates counts across multiple scans in AsyncStorage', async () => {
      const utils = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      fireEvent.press(utils.getByText('+1'));

      // Three scans
      act(() => { capturedOnScanned?.('BL-001'); });
      act(() => { capturedOnScanned?.('BL-001'); });
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        const storedRaw = asyncStorageStore[DRAFT_KEY];
        if (!storedRaw) throw new Error('no draft yet');
        const stored = JSON.parse(storedRaw);
        if (stored[42]?.full !== '3') throw new Error(`expected 3, got ${stored[42]?.full}`);
      });

      const stored = JSON.parse(asyncStorageStore[DRAFT_KEY]);
      expect(stored[42].full).toBe('3');
    });

    it('stores counts for two different products independently', async () => {
      const utils = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      fireEvent.press(utils.getByText('+1'));

      act(() => { capturedOnScanned?.('BL-001'); });
      act(() => { capturedOnScanned?.('BL-001'); });
      act(() => { capturedOnScanned?.('MB-002'); });

      await waitFor(() => {
        const storedRaw = asyncStorageStore[DRAFT_KEY];
        if (!storedRaw) throw new Error('no draft');
        const stored = JSON.parse(storedRaw);
        if (stored[42]?.full !== '2' || stored[99]?.full !== '1') throw new Error('wrong counts');
      });

      const stored = JSON.parse(asyncStorageStore[DRAFT_KEY]);
      expect(stored[42].full).toBe('2');
      expect(stored[99].full).toBe('1');
    });
  });

  // ── 2. Draft is restored after backgrounding (simulated remount) ───────

  describe('2. Draft survives backgrounding (restored on remount)', () => {
    it('restores scan counts from AsyncStorage when the component remounts', async () => {
      // Seed AsyncStorage as if the app was killed mid-session after 3 scans
      asyncStorageStore[DRAFT_KEY] = JSON.stringify({
        42: { productId: 42, full: '3', partial: '0', pct: '', comments: '' },
      });

      const utils = renderScreen();

      // The Full input for product 42 should be restored from the draft
      await waitFor(() => {
        expect(utils.getByDisplayValue('3')).toBeTruthy();
      });
    });

    it('draft is extended correctly after remount — next scan increments from restored count', async () => {
      // Seed: 3 scans were done before the app was backgrounded
      asyncStorageStore[DRAFT_KEY] = JSON.stringify({
        42: { productId: 42, full: '3', partial: '0', pct: '', comments: '' },
      });

      const utils = renderScreen();

      await waitFor(() => {
        expect(utils.getByDisplayValue('3')).toBeTruthy();
      });

      // Enable quick-add and scan once more
      fireEvent.press(utils.getByText('+1'));
      act(() => { capturedOnScanned?.('BL-001'); });

      // The count should be 4 (3 restored + 1 new), not 1
      await waitFor(() => {
        expect(utils.getByDisplayValue('4')).toBeTruthy();
      });

      const stored = JSON.parse(asyncStorageStore[DRAFT_KEY]);
      expect(stored[42].full).toBe('4');
    });

    it('restores counts for multiple products from the draft', async () => {
      asyncStorageStore[DRAFT_KEY] = JSON.stringify({
        42: { productId: 42, full: '5', partial: '0', pct: '', comments: '' },
        99: { productId: 99, full: '2', partial: '0', pct: '', comments: '' },
      });

      const utils = renderScreen();

      await waitFor(() => {
        expect(utils.getByDisplayValue('5')).toBeTruthy();
        expect(utils.getByDisplayValue('2')).toBeTruthy();
      });
    });
  });

  // ── 3. Draft takes precedence over stale server data ──────────────────

  describe('3. Draft takes precedence over server pre-fill when both exist', () => {
    it('uses draft counts, not server counts, when a draft is present', async () => {
      // Server says fullContainers = 2, but the draft has 5 (3 extra scans
      // were done locally after the last server save).
      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 2, partialContainers: 0, estimatedPercentage: null, comments: null }],
      };
      asyncStorageStore[DRAFT_KEY] = JSON.stringify({
        42: { productId: 42, full: '5', partial: '0', pct: '', comments: '' },
      });

      const utils = renderScreen();

      // Should show draft value (5), not server value (2)
      await waitFor(() => {
        expect(utils.getByDisplayValue('5')).toBeTruthy();
      });
      expect(utils.queryByDisplayValue('2')).toBeNull();
    });
  });

  // ── 4. Draft is cleared after a successful server save ────────────────

  describe('4. Draft is cleared after a successful save', () => {
    it('removes the draft from AsyncStorage when the server save succeeds', async () => {
      const utils = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      // Do a scan so there is something to save
      fireEvent.press(utils.getByText('+1'));
      act(() => { capturedOnScanned?.('BL-001'); });

      await waitFor(() => {
        expect(utils.getByDisplayValue('1')).toBeTruthy();
      });

      // Tap "Save Draft"
      await act(async () => {
        fireEvent.press(utils.getByText('Save Draft'));
      });

      await waitFor(() => {
        expect(mockRemoveItem).toHaveBeenCalledWith(DRAFT_KEY);
      });

      expect(asyncStorageStore[DRAFT_KEY]).toBeUndefined();
    });
  });

  // ── 5. Manual text edits write and restore via AsyncStorage ──────────

  describe('5. Manual text edits (changeText) persist through backgrounding', () => {
    it('writes the Full value to AsyncStorage when typed directly into the Full input', async () => {
      // Use a single-product setup for clarity
      mockProducts = [PRODUCT_A];

      const utils = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      // The Full input has placeholder "—"; with one product there is one such input
      // at index 0 (% Full also uses "—" but appears second in render order).
      const fullInput = utils.getAllByPlaceholderText('—')[0];
      fireEvent.changeText(fullInput, '7');

      await waitFor(() => {
        expect(mockSetItem).toHaveBeenCalledWith(
          DRAFT_KEY,
          expect.stringContaining('"full":"7"')
        );
      });

      const stored = JSON.parse(asyncStorageStore[DRAFT_KEY]);
      expect(stored[42]?.full).toBe('7');
    });

    it('writes the Partial value to AsyncStorage when typed directly into the Partial input', async () => {
      mockProducts = [PRODUCT_A];

      const utils = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      // Partial input has placeholder "0"
      const partialInput = utils.getByPlaceholderText('0');
      fireEvent.changeText(partialInput, '3');

      await waitFor(() => {
        expect(mockSetItem).toHaveBeenCalledWith(
          DRAFT_KEY,
          expect.stringContaining('"partial":"3"')
        );
      });

      const stored = JSON.parse(asyncStorageStore[DRAFT_KEY]);
      expect(stored[42]?.partial).toBe('3');
    });

    it('writes the % Full value to AsyncStorage when typed directly into the % Full input', async () => {
      mockProducts = [PRODUCT_A];

      const utils = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      // % Full input is the second input with placeholder "—" (Full is first)
      const pctInput = utils.getAllByPlaceholderText('—')[1];
      fireEvent.changeText(pctInput, '50');

      await waitFor(() => {
        expect(mockSetItem).toHaveBeenCalledWith(
          DRAFT_KEY,
          expect.stringContaining('"pct":"50"')
        );
      });

      const stored = JSON.parse(asyncStorageStore[DRAFT_KEY]);
      expect(stored[42]?.pct).toBe('50');
    });

    it('restores a manually typed Full value when the screen remounts', async () => {
      mockProducts = [PRODUCT_A];

      // First mount — type a value into the Full input
      const first = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      const fullInput = first.getAllByPlaceholderText('—')[0];
      fireEvent.changeText(fullInput, '9');

      await waitFor(() => {
        const raw = asyncStorageStore[DRAFT_KEY];
        if (!raw) throw new Error('draft not written yet');
        const stored = JSON.parse(raw);
        if (stored[42]?.full !== '9') throw new Error(`expected '9', got ${stored[42]?.full}`);
      });

      first.unmount();

      // Second mount — draft should restore the typed value without any scan
      const second = renderScreen();
      await waitFor(() => {
        expect(second.getByDisplayValue('9')).toBeTruthy();
      });
    });

    it('restores manually typed Partial and Full values together on remount', async () => {
      mockProducts = [PRODUCT_A];

      const first = renderScreen();
      await waitFor(() => expect(mockGetItem).toHaveBeenCalledWith(DRAFT_KEY));

      const fullInput = first.getAllByPlaceholderText('—')[0];
      const partialInput = first.getByPlaceholderText('0');

      fireEvent.changeText(fullInput, '4');
      fireEvent.changeText(partialInput, '2');

      await waitFor(() => {
        const raw = asyncStorageStore[DRAFT_KEY];
        if (!raw) throw new Error('draft not written yet');
        const stored = JSON.parse(raw);
        if (stored[42]?.full !== '4' || stored[42]?.partial !== '2') {
          throw new Error(`unexpected: ${JSON.stringify(stored[42])}`);
        }
      });

      first.unmount();

      const second = renderScreen();
      await waitFor(() => {
        expect(second.getByDisplayValue('4')).toBeTruthy();
        expect(second.getByDisplayValue('2')).toBeTruthy();
      });
    });
  });

  // ── 6. Corrupt draft is ignored ───────────────────────────────────────

  describe('6. A corrupt draft does not crash the screen', () => {
    it('falls back to server pre-fill when the stored draft is invalid JSON', async () => {
      asyncStorageStore[DRAFT_KEY] = 'NOT_VALID_JSON{{{{';

      mockSession = {
        id: 1,
        status: 'open',
        items: [{ productId: 42, fullContainers: 7, partialContainers: 0, estimatedPercentage: null, comments: null }],
      };

      const utils = renderScreen();

      // Server pre-fill should work normally; no crash
      await waitFor(() => {
        expect(utils.getByDisplayValue('7')).toBeTruthy();
      });
    });
  });
});
