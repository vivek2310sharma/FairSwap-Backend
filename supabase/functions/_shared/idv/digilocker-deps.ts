import { createClient } from "@supabase/supabase-js";

// Minimal injectable surface so tests can run without a network or database.
export interface IdvDeps {
  makeClient: (url: string, key: string, authHeader?: string) => any;
}

export const defaultDeps: IdvDeps = {
  makeClient: (url, key, authHeader) =>
    createClient(url, key, {
      auth: { persistSession: false },
      ...(authHeader ? { global: { headers: { Authorization: authHeader } } } : {}),
    }),
};
