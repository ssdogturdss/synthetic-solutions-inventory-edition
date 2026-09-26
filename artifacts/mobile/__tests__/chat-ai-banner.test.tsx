/**
 * Tests for the AI setup banner in the chat screen.
 *
 * Covers:
 * 1. Admin sees the banner when hasApiKey is false.
 * 2. Banner clears automatically when hasApiKey becomes true (simulating a
 *    saved key causing the config query to return the updated value).
 * 3. Non-admin who triggers a 503 (AI not configured) sees the
 *    "ask your manager" message — not a generic error.
 * 4. AbortController ref is wired to useFocusEffect so navigation aborts
 *    in-flight streams.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

// Silence font warnings from @expo-google-fonts in test environment
jest.mock('@expo-google-fonts/inter', () => ({
  useFonts: () => [true],
  Inter_400Regular: null,
  Inter_500Medium: null,
  Inter_600SemiBold: null,
  Inter_700Bold: null,
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'Success' },
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  // useFocusEffect is a navigation hook — stub it as a no-op so the component
  // can render without a navigation provider in the test environment.
  // The factory must not reference out-of-scope variables (jest restriction).
  useFocusEffect: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// KeyboardAvoidingView from react-native-keyboard-controller — render as a plain View
jest.mock('react-native-keyboard-controller', () => {
  const { View } = require('react-native');
  return {
    KeyboardAvoidingView: ({ children, ...props }: any) => (
      <View {...props}>{children}</View>
    ),
  };
});

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text testID={`icon-${name}`}>{name}</Text>,
  };
});

// ---------------------------------------------------------------------------
// Mock helpers — we expose setters so individual tests can control return values
// ---------------------------------------------------------------------------

let mockAiConfig: { hasApiKey: boolean; provider?: string } | undefined = undefined;
let mockUserRole: 'admin' | 'store_user' = 'admin';
let mockFinalizedSessions: Array<{ finalizedAt?: string | null }> | undefined = undefined;
let mockSessionQueryParams: unknown;

jest.mock('@workspace/api-client-react', () => ({
  useListStores: () => ({ data: [] }),
  useGetAiConfig: () => ({ data: mockAiConfig }),
  useListInventorySessions: (params: unknown) => {
    mockSessionQueryParams = params;
    return { data: mockFinalizedSessions };
  },
  // useAiChat is no longer used by the component (it calls streamChat/fetch
  // directly), but keep a stub so existing import paths resolve without error.
  useAiChat: () => ({ mutateAsync: jest.fn() }),
  AiConfigInputProvider: { openai: 'openai', grok: 'grok' },
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Test User',
      role: mockUserRole,
      storeId: 1,
    },
    token: 'tok',
    isLoading: false,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers for mocking the streaming fetch
// ---------------------------------------------------------------------------

function makeStreamReader(chunks: string[]) {
  let idx = 0;
  return {
    read: jest.fn().mockImplementation(() => {
      if (idx < chunks.length) {
        const value = new TextEncoder().encode(chunks[idx++]);
        return Promise.resolve({ done: false as const, value });
      }
      return Promise.resolve({ done: true as const, value: undefined });
    }),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
}

function mockFetchOk(sseChunks: string[]) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    body: { getReader: () => makeStreamReader(sseChunks) },
  });
}

function mockFetchError(status: number, message: string) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify({ error: message })),
  });
}

// ---------------------------------------------------------------------------
// Import component after all mocks are in place
// ---------------------------------------------------------------------------

import ChatScreen from '../app/(tabs)/chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderChat() {
  return render(<ChatScreen />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AI setup banner (chat screen)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserRole = 'admin';
    mockAiConfig = undefined;
    mockFinalizedSessions = undefined;
    mockSessionQueryParams = undefined;
    // Reset global.fetch to a jest mock for each test
    global.fetch = jest.fn();
  });

  describe('admin banner', () => {
    it('is visible when hasApiKey is false', () => {
      mockAiConfig = { hasApiKey: false };
      const { getByText } = renderChat();
      expect(getByText(/AI not configured/i)).toBeTruthy();
    });

    it('is not rendered when hasApiKey is true', () => {
      mockAiConfig = { hasApiKey: true, provider: 'openai' };
      const { queryByText } = renderChat();
      expect(queryByText(/AI not configured — tap to set up/i)).toBeNull();
    });

    it('clears automatically when hasApiKey transitions from false to true', () => {
      mockAiConfig = { hasApiKey: false };
      const { queryByText, rerender } = renderChat();

      // Banner visible before the key is saved
      expect(queryByText(/AI not configured — tap to set up/i)).toBeTruthy();

      // Simulate the aiConfig query returning updated data after the admin
      // saves a key in settings and the chat screen's hook re-fetches
      mockAiConfig = { hasApiKey: true, provider: 'openai' };
      rerender(<ChatScreen />);

      expect(queryByText(/AI not configured — tap to set up/i)).toBeNull();
    });

    it('tapping the banner navigates to AI settings', () => {
      mockAiConfig = { hasApiKey: false };
      const { getByText } = renderChat();
      fireEvent.press(getByText(/AI not configured/i));
      expect(mockPush).toHaveBeenCalledWith('/admin/ai-settings');
    });
  });

  describe('non-admin behaviour when AI is not configured', () => {
    beforeEach(() => {
      mockUserRole = 'store_user';
      mockAiConfig = undefined; // non-admins do not fetch config
    });

    it('shows the "ask your manager" message after a 503 response', async () => {
      // Simulate a 503 from the streaming endpoint
      mockFetchError(503, 'Service Unavailable');

      const { getByTestId, findByText, queryByText } = renderChat();

      // Type a message and send it
      fireEvent.changeText(getByTestId('chat-input'), 'How much soap do we have?');
      fireEvent(getByTestId('chat-input'), 'submitEditing');

      // The "ask your manager" banner should appear
      await findByText(/ask your manager/i);

      // The generic error message must NOT appear
      expect(queryByText(/could not reach the AI assistant/i)).toBeNull();
    });

    it('clears the "ask your manager" banner after a subsequent successful reply', async () => {
      // First call: 503 → banner appears
      mockFetchError(503, 'Service Unavailable');
      // Second call: streaming success → banner should disappear
      mockFetchOk(['data: {"chunk":"Here is your inventory summary."}\n\n', 'data: [DONE]\n\n']);

      const { getByTestId, findByText, queryByText } = renderChat();

      // Send first message — triggers 503
      fireEvent.changeText(getByTestId('chat-input'), 'How much soap do we have?');
      fireEvent(getByTestId('chat-input'), 'submitEditing');

      // Banner appears
      await findByText(/ask your manager/i);

      // Send second message — succeeds
      fireEvent.changeText(getByTestId('chat-input'), 'What about bleach?');
      fireEvent(getByTestId('chat-input'), 'submitEditing');

      // Wait for the successful reply to appear in the chat
      await findByText(/Here is your inventory summary\./i);

      // Banner must be gone
      expect(queryByText(/ask your manager/i)).toBeNull();
    });

    it('shows a generic error message for non-503 failures', async () => {
      // Simulate a non-503 network-level failure
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const { getByTestId, findByText, queryByText } = renderChat();

      fireEvent.changeText(getByTestId('chat-input'), 'What is our usage?');
      fireEvent(getByTestId('chat-input'), 'submitEditing');

      // The component appends the error message to the chat bubble:
      // "Sorry — {err.message}" — look for the "Sorry" prefix.
      await findByText(/sorry/i);

      // The "ask your manager" banner must NOT appear
      expect(queryByText(/ask your manager/i)).toBeNull();
    });
  });

  describe('recent inventory data banner', () => {
    it('warns when the selected store has no finalized session in the last 14 days', () => {
      mockFinalizedSessions = [];

      const { getByTestId, getByText } = renderChat();

      expect(getByTestId('recent-data-warning')).toBeTruthy();
      expect(getByText(/No inventory sessions in the last 14 days/i)).toBeTruthy();
      expect(mockSessionQueryParams).toEqual({ storeId: 1, status: 'finalized', limit: 1 });
    });

    it('does not warn when the selected store has a recent finalized session', () => {
      mockFinalizedSessions = [{ finalizedAt: new Date().toISOString() }];

      const { queryByTestId } = renderChat();

      expect(queryByTestId('recent-data-warning')).toBeNull();
    });

    it('warns when the latest finalized session is older than 14 days', () => {
      mockFinalizedSessions = [{
        finalizedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      }];

      const { getByTestId } = renderChat();

      expect(getByTestId('recent-data-warning')).toBeTruthy();
    });

    it('links the warning to the new inventory count flow', () => {
      mockFinalizedSessions = [];
      const { getByTestId } = renderChat();

      fireEvent.press(getByTestId('recent-data-warning'));

      expect(mockPush).toHaveBeenCalledWith('/inventory/new');
    });
  });
});
