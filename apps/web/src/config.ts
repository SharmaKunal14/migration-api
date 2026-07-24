import { z } from 'zod';

const browserConfigurationSchema = z.object({
  VITE_API_BASE_URL: z.string().min(1),
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

export const browserConfiguration = browserConfigurationSchema.parse(import.meta.env);
