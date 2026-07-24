import { createClient } from '@supabase/supabase-js';

import { browserConfiguration } from './config.js';

export const supabase = createClient(
  browserConfiguration.VITE_SUPABASE_URL,
  browserConfiguration.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
    },
  },
);
