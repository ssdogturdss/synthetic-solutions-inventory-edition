import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack, useRouter, useSegments } from 'expo-router';
import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { setBaseUrl } from '@workspace/api-client-react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { OfflineQueueProvider } from '@/contexts/OfflineQueueContext';
import { API_BASE_URL } from '@/constants/api';

// Set base URL at module level so all API calls use the right domain
setBaseUrl(API_BASE_URL);

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

function AuthGate() {
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    const inAuth = segments[0] === '(auth)';
    const inKiosk = segments[0] === 'kiosk';
    if (!user && !inAuth && !inKiosk) {
      router.replace('/(auth)/login');
    } else if (user && inAuth) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, segments]);

  return null;
}

function NativePushNavigation() {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let responseSubscription: { remove: () => void } | undefined;
    let cancelled = false;
    const openNotificationRoute = (response: any) => {
      const route = response?.notification?.request?.content?.data?.route;
      if (route === '/admin/backup-health' || route === '/reports/alerts') {
        router.push(route);
      }
    };

    void import('expo-notifications').then(async (Notifications) => {
      if (cancelled) return;
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
      const lastResponse = await Notifications.getLastNotificationResponseAsync();
      if (lastResponse) {
        openNotificationRoute(lastResponse);
        await Notifications.clearLastNotificationResponseAsync();
      }
      responseSubscription =
        Notifications.addNotificationResponseReceivedListener(openNotificationRoute);
    });

    return () => {
      cancelled = true;
      responseSubscription?.remove();
    };
  }, [router]);

  return null;
}

function RootLayoutNav() {
  return (
    <>
      <AuthGate />
      <NativePushNavigation />
      <Stack>
        <Stack.Screen name="(auth)" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="inventory/new" options={{ title: 'New Count Session', headerBackTitle: 'Back' }} />
        <Stack.Screen name="inventory/[id]" options={{ title: 'Inventory Count', headerBackTitle: 'Back' }} />
        <Stack.Screen name="receive/new" options={{ title: 'Log Delivery', headerBackTitle: 'Back' }} />
        <Stack.Screen name="receive/[id]" options={{ title: 'Delivery Details', headerBackTitle: 'Back' }} />
        <Stack.Screen name="usage/new" options={{ title: 'Pull Chemical', headerBackTitle: 'Back' }} />
        <Stack.Screen name="reports/usage-report" options={{ title: 'Usage Report', headerBackTitle: 'Back' }} />
        <Stack.Screen name="reports/alerts" options={{ title: 'Stock Alerts', headerBackTitle: 'Back' }} />
        <Stack.Screen name="reports/valuation" options={{ title: 'Inventory Valuation', headerBackTitle: 'Back' }} />
        <Stack.Screen name="reports/ai-report" options={{ title: 'AI Report Agent', headerBackTitle: 'Back' }} />
        <Stack.Screen name="notifications" options={{ title: 'Notifications', headerBackTitle: 'Back' }} />
        <Stack.Screen name="admin" options={{ headerShown: false }} />
        <Stack.Screen name="kiosk/[storeId]" options={{ headerShown: false, animation: 'fade' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <OfflineQueueProvider>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <KeyboardProvider>
                  <RootLayoutNav />
                </KeyboardProvider>
              </GestureHandlerRootView>
            </OfflineQueueProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
