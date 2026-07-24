import type { Session } from '@supabase/supabase-js';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import { supabase } from './supabase.js';

interface AuthState {
  readonly loading: boolean;
  readonly session: Session | null;
}

const AuthContext = createContext<AuthState>({ loading: true, session: null });

export function AuthProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [state, setState] = useState<AuthState>({ loading: true, session: null });

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setState({ loading: false, session: data.session });
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) {
        setState({ loading: false, session });
      }
    });
    return (): void => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(() => state, [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
