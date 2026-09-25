import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Tokens, AuthState, LoginRequest, RegisterRequest } from '@/types';
import * as authApi from '@/api/auth';

interface AuthStore extends AuthState {
  login: (credentials: LoginRequest) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  logout: () => void;
  restoreSession: () => Promise<boolean>;
  setTokens: (tokens: Tokens) => void;
  setUser: (user: User) => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: true,

      login: async (credentials: LoginRequest): Promise<void> => {
        set({ isLoading: true });
        try {
          const { user, tokens } = await authApi.login(credentials);
          localStorage.setItem('accessToken', tokens.accessToken);
          localStorage.setItem('refreshToken', tokens.refreshToken);
          localStorage.setItem('user', JSON.stringify(user));
          set({
            user,
            tokens,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      register: async (data: RegisterRequest): Promise<void> => {
        set({ isLoading: true });
        try {
          const { user, tokens } = await authApi.register(data);
          localStorage.setItem('accessToken', tokens.accessToken);
          localStorage.setItem('refreshToken', tokens.refreshToken);
          localStorage.setItem('user', JSON.stringify(user));
          set({
            user,
            tokens,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      forgotPassword: async (email: string): Promise<void> => {
        await authApi.forgotPassword({ email });
      },

      logout: (): void => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        set({
          user: null,
          tokens: null,
          isAuthenticated: false,
          isLoading: false,
        });
      },

      restoreSession: async (): Promise<boolean> => {
        set({ isLoading: true });
        const refreshTokenValue = localStorage.getItem('refreshToken');
        const storedUser = localStorage.getItem('user');

        if (!refreshTokenValue) {
          set({ isLoading: false });
          return false;
        }

        try {
          let user: User | null = null;

          if (storedUser) {
            try {
              user = JSON.parse(storedUser) as User;
            } catch {
              user = null;
            }
          }

          if (!user) {
            user = await authApi.getProfile();
            localStorage.setItem('user', JSON.stringify(user));
          }

          const accessToken = localStorage.getItem('accessToken');
          set({
            user,
            tokens: accessToken
              ? { accessToken, refreshToken: refreshTokenValue }
              : null,
            isAuthenticated: !!accessToken,
            isLoading: false,
          });
          return !!accessToken;
        } catch {
          try {
            const newTokens = await authApi.refreshToken(refreshTokenValue);
            localStorage.setItem('accessToken', newTokens.accessToken);
            localStorage.setItem('refreshToken', newTokens.refreshToken);

            const user = await authApi.getProfile();
            localStorage.setItem('user', JSON.stringify(user));

            set({
              user,
              tokens: newTokens,
              isAuthenticated: true,
              isLoading: false,
            });
            return true;
          } catch {
            get().logout();
            return false;
          }
        }
      },

      setTokens: (tokens: Tokens): void => {
        set({ tokens });
      },

      setUser: (user: User): void => {
        set({ user });
      },

      setLoading: (loading: boolean): void => {
        set({ isLoading: loading });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

if (typeof window !== 'undefined') {
  window.addEventListener('auth:logout', () => {
    useAuthStore.getState().logout();
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  });
}
