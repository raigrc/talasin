import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "../env";

/**
 * Supabase client bound to the SERVICE-ROLE key. Server-only.
 *
 * This client bypasses RLS and is the ONLY way the app touches the database
 * (DESIGN.md §2.7). The anon key is never shipped to the browser and the browser
 * never talks to Supabase directly — it only calls our own Route Handlers.
 *
 * `server-only` makes importing this into a Client Component a build error.
 */

let cached: SupabaseClient | null = null;

/**
 * Lazily construct the service-role client. Lazy so a missing env var surfaces
 * at request time (as a clean 500) rather than crashing the build / import.
 */
export function getServiceClient(): SupabaseClient {
  if (cached) return cached;

  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  cached = createClient(url, serviceRoleKey, {
    auth: {
      // No user sessions — this is a service-role machine client.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { "x-talasin": "server" },
    },
  });

  return cached;
}
