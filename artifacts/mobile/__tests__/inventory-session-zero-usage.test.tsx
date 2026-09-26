/**
 * Tests for the Usage Summary panel when all session items have zero consumption.
 *
 * Covers:
 * 1. The "N not consumed" toggle appears when every product has zero usage.
 * 2. "No products with recorded usage." is shown in the non-zero section.
 * 3. Expanding the toggle reveals all products with "No usage" labels.
 * 4. The toggle collapses the list when pressed a second time.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

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

jest.mock('@/components/BarcodeScannerSheet', () => {
  const React = require('react');
  return {
    BarcodeScannerSheet: () => null,
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
  previousItems?: Array<{ productId: number; fullContainers: number; estimatedGallons?: string }>;
};

let mockSession: MockSession | undefined;
let mockProducts: Array<{ id: number; name: string; unit?: string; productNumber?: string }> = [];
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
    mutateAsync: jest.fn().mockResolvedValue([]),
    isPending: false,
  }),
  useFinalizeInventorySession: () => ({
    mutateAsync: jest.fn().mockResolvedValue({}),
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
  useNavigation: () => ({
    setOptions: jest.fn(),
    addListener: jest.fn(() => jest.fn()), // returns an unsubscribe no-op
    dispatch: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import the component under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import InventorySessionScreen from '../app/inventory/[id]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRODUCT_A = { id: 1, name: 'Bleach 1-gal', unit: 'gallon', productNumber: 'BL-001' };
const PRODUCT_B = { id: 2, name: 'Mop Bucket', unit: 'each', productNumber: 'MB-002' };
const PRODUCT_C = { id: 3, name: 'Hand Soap', unit: 'bottle', productNumber: 'HS-003' };

function renderScreen() {
  return render(<InventorySessionScreen />);
}

/** Build a finalized session where every product has zero usage. */
function buildAllZeroSession(
  products: typeof mockProducts,
): MockSession {
  return {
    id: 1,
    status: 'finalized',
    items: products.map((p) => ({
      productId: p.id,
      fullContainers: 0,
      partialContainers: 0,
      estimatedPercentage: null,
      comments: null,
    })),
    usageSummary: products.map((p) => ({
      productId: p.id,
      productName: p.name,
      usage: '0',
    })),
    previousItems: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inventory session — zero-usage products in Usage Summary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProducts = [PRODUCT_A, PRODUCT_B, PRODUCT_C];
    mockSession = buildAllZeroSession(mockProducts);
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // ── 1. Toggle button appears with correct count ─────────────────────────

  it('shows the "N not consumed" toggle when all products have zero usage', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      // The zero-usage toggle should be visible with the count of all products
      expect(
        utils.getByLabelText(`Show ${mockProducts.length} zero-usage products`)
      ).toBeTruthy();
    });
  });

  // ── 2. Non-zero section shows empty state, not a crash ──────────────────

  it('shows "No products with recorded usage." when there are no non-zero items', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      expect(utils.getByText('No products with recorded usage.')).toBeTruthy();
    });
  });

  // ── 3. Expanding the toggle reveals all products with "No usage" labels ─

  it('reveals all products with "No usage" labels when the toggle is expanded', async () => {
    const utils = renderScreen();

    // Wait for the toggle to appear
    await waitFor(() => {
      expect(
        utils.getByLabelText(`Show ${mockProducts.length} zero-usage products`)
      ).toBeTruthy();
    });

    // Expand the zero-usage section
    fireEvent.press(
      utils.getByLabelText(`Show ${mockProducts.length} zero-usage products`)
    );

    // Every zero-usage row should carry a "No usage" label
    await waitFor(() => {
      const noUsageLabels = utils.getAllByText('No usage');
      expect(noUsageLabels).toHaveLength(mockProducts.length);
    });
  });

  // ── 4. Toggle collapses the list on second press ────────────────────────

  it('collapses the zero-usage list when the toggle is pressed a second time', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      expect(
        utils.getByLabelText(`Show ${mockProducts.length} zero-usage products`)
      ).toBeTruthy();
    });

    // Expand
    fireEvent.press(
      utils.getByLabelText(`Show ${mockProducts.length} zero-usage products`)
    );

    await waitFor(() => {
      // Toggle label changes to hide when expanded; "No usage" labels are visible
      expect(utils.getByLabelText('Hide zero-usage products')).toBeTruthy();
      expect(utils.getAllByText('No usage')).toHaveLength(mockProducts.length);
    });

    // Collapse
    fireEvent.press(utils.getByLabelText('Hide zero-usage products'));

    await waitFor(() => {
      // "No usage" labels should disappear after collapse
      expect(utils.queryAllByText('No usage')).toHaveLength(0);
      // Toggle returns to "Show N" label
      expect(
        utils.getByLabelText(`Show ${mockProducts.length} zero-usage products`)
      ).toBeTruthy();
    });
  });

  // ── 5. Single-product edge case ─────────────────────────────────────────

  it('uses singular grammar in the toggle label when exactly one product has zero usage', async () => {
    mockProducts = [PRODUCT_A];
    mockSession = buildAllZeroSession(mockProducts);

    const utils = renderScreen();

    await waitFor(() => {
      // Singular: "1 zero-usage product" (no trailing 's')
      expect(
        utils.getByLabelText('Show 1 zero-usage product')
      ).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Mixed-usage suite: some products consumed, some not
// ---------------------------------------------------------------------------

/**
 * Build a finalized session where PRODUCT_A and PRODUCT_B have non-zero usage
 * and PRODUCT_C has zero usage.
 */
function buildMixedSession(): MockSession {
  return {
    id: 1,
    status: 'finalized',
    items: [
      { productId: PRODUCT_A.id, fullContainers: 3, partialContainers: 0, estimatedPercentage: null, comments: null },
      { productId: PRODUCT_B.id, fullContainers: 1, partialContainers: 0, estimatedPercentage: null, comments: null },
      { productId: PRODUCT_C.id, fullContainers: 0, partialContainers: 0, estimatedPercentage: null, comments: null },
    ],
    usageSummary: [
      { productId: PRODUCT_A.id, productName: PRODUCT_A.name, usage: '5.5' },
      { productId: PRODUCT_B.id, productName: PRODUCT_B.name, usage: '3' },
      { productId: PRODUCT_C.id, productName: PRODUCT_C.name, usage: '0' },
    ],
    previousItems: [],
  };
}

describe('Inventory session — mixed consumed/unconsumed products in Usage Summary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProducts = [PRODUCT_A, PRODUCT_B, PRODUCT_C];
    mockSession = buildMixedSession();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // ── 1. Non-zero section lists only consumed products ────────────────────

  it('lists only consumed products with their usage figures in the non-zero section', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      // Both consumed products appear with formatted usage values — these are
      // unique to the usage summary section and confirm the non-zero rows rendered.
      expect(utils.getByText('5.50')).toBeTruthy();
      expect(utils.getByText('3.00')).toBeTruthy();
    });

    // Product names may also appear in the FlatList rows, so use getAllByText
    // (which accepts multiple matches) to confirm presence without throwing.
    expect(utils.getAllByText(PRODUCT_A.name).length).toBeGreaterThanOrEqual(1);
    expect(utils.getAllByText(PRODUCT_B.name).length).toBeGreaterThanOrEqual(1);
  });

  // ── 2. Zero-usage toggle appears with the correct count ─────────────────

  it('shows the "N not consumed" toggle for the single unconsumed product', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      // One unconsumed product → singular label
      expect(
        utils.getByLabelText('Show 1 zero-usage product')
      ).toBeTruthy();
    });
  });

  // ── 3. Non-zero section does not show the unconsumed product ────────────

  it('does not show the unconsumed product in the non-zero section before expanding the toggle', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      // Consumed products appear with their usage figures in the non-zero section.
      // Using the formatted usage value as a stable, unique selector avoids
      // duplicates caused by the product name also appearing in the FlatList rows.
      expect(utils.getByText('5.50')).toBeTruthy();
      expect(utils.getByText('3.00')).toBeTruthy();
    });

    // The "No usage" label is hidden until the toggle is expanded.
    expect(utils.queryAllByText('No usage')).toHaveLength(0);
  });

  // ── 4. Expanding the toggle reveals only unconsumed products ────────────

  it('reveals only the unconsumed product with a "No usage" label when the toggle is expanded', async () => {
    const utils = renderScreen();

    // Wait for the toggle to appear
    await waitFor(() => {
      expect(utils.getByLabelText('Show 1 zero-usage product')).toBeTruthy();
    });

    // Expand the zero-usage section
    fireEvent.press(utils.getByLabelText('Show 1 zero-usage product'));

    await waitFor(() => {
      // Exactly one "No usage" label — only the unconsumed product
      const noUsageLabels = utils.getAllByText('No usage');
      expect(noUsageLabels).toHaveLength(1);
    });

    // The unconsumed product name is now visible (may also appear in the
    // FlatList rows, so we assert at least one occurrence rather than exactly one).
    expect(utils.getAllByText(PRODUCT_C.name).length).toBeGreaterThanOrEqual(1);
  });

  // ── 5. Consumed products are absent from the expanded zero-usage list ───

  it('does not leak consumed products into the expanded zero-usage list', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      expect(utils.getByLabelText('Show 1 zero-usage product')).toBeTruthy();
    });

    fireEvent.press(utils.getByLabelText('Show 1 zero-usage product'));

    await waitFor(() => {
      // Only one "No usage" label — consumed products must not appear there
      expect(utils.getAllByText('No usage')).toHaveLength(1);
    });

    // Consumed products still show their usage figures, not "No usage"
    expect(utils.getByText('5.50')).toBeTruthy();
    expect(utils.getByText('3.00')).toBeTruthy();
  });

  // ── 6. Collapsing the toggle hides the unconsumed product again ─────────

  it('hides the unconsumed product after collapsing the toggle', async () => {
    const utils = renderScreen();

    await waitFor(() => {
      expect(utils.getByLabelText('Show 1 zero-usage product')).toBeTruthy();
    });

    // Expand
    fireEvent.press(utils.getByLabelText('Show 1 zero-usage product'));

    await waitFor(() => {
      expect(utils.getAllByText('No usage')).toHaveLength(1);
      expect(utils.getByLabelText('Hide zero-usage products')).toBeTruthy();
    });

    // Collapse
    fireEvent.press(utils.getByLabelText('Hide zero-usage products'));

    await waitFor(() => {
      // "No usage" label disappears
      expect(utils.queryAllByText('No usage')).toHaveLength(0);
      // Toggle returns to its "Show" state
      expect(utils.getByLabelText('Show 1 zero-usage product')).toBeTruthy();
    });

    // Consumed products remain visible in the non-zero section
    expect(utils.getByText('5.50')).toBeTruthy();
    expect(utils.getByText('3.00')).toBeTruthy();
  });
});
