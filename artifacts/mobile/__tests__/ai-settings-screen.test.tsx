/**
 * Tests for the AI settings screen.
 *
 * Covers:
 * 1. Status card shows orange "AI not configured" when hasApiKey is false.
 * 2. Status card switches to green "AI configured" immediately after a
 *    successful save (refetch returns hasApiKey: true).
 * 3. Alert "Saved" is shown on a successful save.
 * 4. Alert "Error" is shown when the save mutation throws.
 * 5. "Test connection" button shows a success label when the saved key is used
 *    (no new key entered) and the test mutation resolves ok.
 * 6. "Test connection" button shows the error message when the test mutation
 *    throws (server unreachable path).
 * 7. The full server-provided default prompt is pre-filled and can be restored.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them
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
  NotificationFeedbackType: { Success: 'Success', Error: 'Error' },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => (
      <Text testID={`icon-${name}`}>{name}</Text>
    ),
  };
});

jest.mock('@/components/LoadingState', () => {
  const { Text } = require('react-native');
  return {
    LoadingState: () => <Text>Loading…</Text>,
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
  }),
}));

// ---------------------------------------------------------------------------
// Controllable API-client mock
// ---------------------------------------------------------------------------

let mockConfig: { hasApiKey: boolean; provider?: string; systemPrompt?: string } | undefined =
  undefined;
let mockRefetch: jest.Mock;
let mockUpdateConfig: jest.Mock;
let mockTestConfig: jest.Mock;

jest.mock('@workspace/api-client-react', () => ({
  useGetAiConfig: () => ({
    data: mockConfig,
    isLoading: false,
    refetch: mockRefetch,
  }),
  useUpdateAiConfig: () => ({
    mutateAsync: mockUpdateConfig,
    isPending: false,
  }),
  useTestAiConfig: () => ({
    mutateAsync: mockTestConfig,
    isPending: false,
  }),
  AiConfigInputProvider: { openai: 'openai', grok: 'grok' },
}));

// ---------------------------------------------------------------------------
// Import component after all mocks are in place
// ---------------------------------------------------------------------------

import AiSettingsScreen from '../app/admin/ai-settings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderScreen() {
  return render(<AiSettingsScreen />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AiSettingsScreen', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = { hasApiKey: false };
    mockRefetch = jest.fn();
    mockUpdateConfig = jest.fn();
    mockTestConfig = jest.fn();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('shows the orange "AI not configured" status card when hasApiKey is false', () => {
    const { getByText } = renderScreen();
    expect(getByText(/AI not configured/i)).toBeTruthy();
  });

  it('pre-fills the system prompt returned by the server', () => {
    const defaultPrompt = 'You are the AI assistant for Red Carpet Car Wash.\n\nAccuracy rules:\n- NEVER fabricate data';
    mockConfig = { hasApiKey: true, provider: 'openai', systemPrompt: defaultPrompt };

    const { getByDisplayValue } = renderScreen();

    expect(getByDisplayValue(defaultPrompt)).toBeTruthy();
  });

  it('clears the custom prompt and restores the server default', async () => {
    const customPrompt = 'Use this custom instruction.';
    const defaultPrompt = 'You are the AI assistant for Red Carpet Car Wash.';
    mockConfig = { hasApiKey: true, provider: 'openai', systemPrompt: customPrompt };
    mockUpdateConfig.mockResolvedValueOnce({
      hasApiKey: true,
      provider: 'openai',
      systemPrompt: defaultPrompt,
    });
    mockRefetch.mockResolvedValueOnce(undefined);

    const { getByText, getByDisplayValue } = renderScreen();
    fireEvent.press(getByText('Reset to default'));

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledWith({
      data: { systemPrompt: '' },
    }));
    await waitFor(() => expect(getByDisplayValue(defaultPrompt)).toBeTruthy());
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('shows the green "AI configured" status card immediately after a successful save', async () => {
    // Save succeeds; refetch mutates mockConfig so the re-render sees hasApiKey: true.
    mockUpdateConfig.mockResolvedValueOnce({});
    mockRefetch.mockImplementation(() => {
      mockConfig = { hasApiKey: true, provider: 'openai' };
    });

    const { getByText, getByPlaceholderText, rerender } = renderScreen();

    // Initially unconfigured
    expect(getByText(/AI not configured/i)).toBeTruthy();

    // Type an API key so the guard in handleSave is satisfied
    fireEvent.changeText(getByPlaceholderText(/sk-/i), 'sk-test-key-1234');

    // Press Save AI Settings
    fireEvent.press(getByText('Save AI Settings'));

    // Wait for the save mutation + refetch to resolve
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockRefetch).toHaveBeenCalledTimes(1));

    // Re-render with updated mockConfig to simulate React Query propagating the refetch
    rerender(<AiSettingsScreen />);

    // Status card should now show the green configured text
    expect(getByText(/AI configured/i)).toBeTruthy();
  });

  it('shows a "Saved" alert on a successful save', async () => {
    mockUpdateConfig.mockResolvedValueOnce({});
    mockRefetch.mockResolvedValueOnce(undefined);

    const { getByText, getByPlaceholderText } = renderScreen();

    fireEvent.changeText(getByPlaceholderText(/sk-/i), 'sk-test-key-9999');
    fireEvent.press(getByText('Save AI Settings'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Saved', 'AI settings updated successfully.'),
    );
  });

  it('shows an "Error" alert when the save mutation throws', async () => {
    mockUpdateConfig.mockRejectedValueOnce(new Error('Network failure'));

    const { getByText, getByPlaceholderText } = renderScreen();

    fireEvent.changeText(getByPlaceholderText(/sk-/i), 'sk-bad-key');
    fireEvent.press(getByText('Save AI Settings'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Error', 'Failed to save AI settings.'),
    );
  });

  it('shows "API Key required" alert when saving with no key and no existing key', async () => {
    // mockConfig already has hasApiKey: false and no key is typed
    const { getByText } = renderScreen();

    fireEvent.press(getByText('Save AI Settings'));

    expect(alertSpy).toHaveBeenCalledWith('API Key required', expect.any(String));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('shows the success label in the test button when the saved key passes (no new key entered)', async () => {
    // A key is already saved — the component omits apiKey from the payload so the
    // server uses the stored value.
    mockConfig = { hasApiKey: true, provider: 'openai' };
    mockTestConfig.mockResolvedValueOnce({ ok: true, provider: 'openai' });

    const { getByText } = renderScreen();

    // No new key is typed; just press "Test connection"
    fireEvent.press(getByText('Test connection'));

    // The mutation should have been called without an apiKey field
    await waitFor(() => expect(mockTestConfig).toHaveBeenCalledTimes(1));
    expect(mockTestConfig).toHaveBeenCalledWith({
      data: { provider: 'openai' },
    });

    // Button text must now read the success label
    await waitFor(() => expect(getByText(/Connected to openai/i)).toBeTruthy());
  });

  it('shows the error message in the test button when the test mutation throws', async () => {
    // A key is already saved
    mockConfig = { hasApiKey: true, provider: 'openai' };
    mockTestConfig.mockRejectedValueOnce(new Error('Network failure'));

    const { getByText } = renderScreen();

    fireEvent.press(getByText('Test connection'));

    await waitFor(() =>
      expect(getByText(/Could not reach the server/i)).toBeTruthy(),
    );
  });
});
