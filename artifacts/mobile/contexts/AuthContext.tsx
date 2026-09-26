import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { setAuthTokenGetter } from '@workspace/api-client-react';
import { login as apiLogin } from '@workspace/api-client-react';
import type { UserProfile } from '@workspace/api-client-react';
import { API_BASE_URL } from '@/constants/api';

const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

interface AuthContextType {
  user: UserProfile | null;
  token: string | null;
  isLoading: boolean;
  login: (params: { name?: string | null; userId?: number | null; pin: string }) => Promise<void>;
  logout: () => Promise<void>;
  biometricLogin: () => Promise<boolean>;
  resetInactivityTimer: () => void;
  canUseBiometric: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const tokenRef = { current: null as string | null };

// Set getter once at module level — always returns latest token
setAuthTokenGetter(() => tokenRef.current);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [canUseBiometric, setCanUseBiometric] = useState(false);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep module-level ref in sync
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // Check biometric availability
  useEffect(() => {
    if (Platform.OS === 'web') return;
    (async () => {
      try {
        const LocalAuth = await import('expo-local-authentication');
        const hasHardware = await LocalAuth.hasHardwareAsync();
        const isEnrolled = await LocalAuth.isEnrolledAsync();
        setCanUseBiometric(hasHardware && isEnrolled);
      } catch {
        setCanUseBiometric(false);
      }
    })();
  }, []);

  // Load stored session
  useEffect(() => {
    (async () => {
      try {
        const [storedToken, storedUser] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          AsyncStorage.getItem(USER_KEY),
        ]);
        if (storedToken && storedUser) {
          tokenRef.current = storedToken;
          const cachedUser = JSON.parse(storedUser) as UserProfile;
          let sessionUser = cachedUser;

          // Do not keep showing an admin UI for a token that the API no
          // longer accepts. Preserve the cached session on network errors so
          // the app can still support its existing offline behavior.
          try {
            const response = await fetch(`${API_BASE_URL ?? ''}/api/auth/me`, {
              headers: { Authorization: `Bearer ${storedToken}` },
            });
            if (response.status === 401) {
              tokenRef.current = null;
              await Promise.all([
                AsyncStorage.removeItem(TOKEN_KEY),
                AsyncStorage.removeItem(USER_KEY),
              ]);
              return;
            }
            if (response.ok) {
              sessionUser = (await response.json()) as UserProfile;
              await AsyncStorage.setItem(USER_KEY, JSON.stringify(sessionUser));
            }
          } catch {
            // Keep the cached session when the API is temporarily unreachable.
          }

          setToken(storedToken);
          setUser(sessionUser);
        }
      } catch {
        // Ignore storage errors
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // App state change handler — reset timer on foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') resetInactivityTimer();
    });
    return () => sub.remove();
  }, []);

  const resetInactivityTimer = () => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    if (!tokenRef.current) return;
    inactivityTimer.current = setTimeout(() => {
      logout();
    }, INACTIVITY_TIMEOUT);
  };

  const login = async ({ name, userId, pin }: { name?: string | null; userId?: number | null; pin: string }) => {
    const resp = await apiLogin({ name: name ?? null, userId: userId ?? null, pin });
    tokenRef.current = resp.token;
    setToken(resp.token);
    setUser(resp.user);
    await Promise.all([
      AsyncStorage.setItem(TOKEN_KEY, resp.token),
      AsyncStorage.setItem(USER_KEY, JSON.stringify(resp.user)),
    ]);
    resetInactivityTimer();
  };

  const logout = async () => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    tokenRef.current = null;
    setToken(null);
    setUser(null);
    await Promise.all([
      AsyncStorage.removeItem(TOKEN_KEY),
      AsyncStorage.removeItem(USER_KEY),
    ]);
  };

  const biometricLogin = async (): Promise<boolean> => {
    if (Platform.OS === 'web') return false;
    try {
      const LocalAuth = await import('expo-local-authentication');
      const result = await LocalAuth.authenticateAsync({
        promptMessage: 'Sign in to Red Carpet Car Wash',
        cancelLabel: 'Use PIN instead',
        fallbackLabel: 'Use PIN',
      });
      return result.success;
    } catch {
      return false;
    }
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout, biometricLogin, resetInactivityTimer, canUseBiometric }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
