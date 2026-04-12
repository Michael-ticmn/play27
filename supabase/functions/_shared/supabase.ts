import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Service-role client — bypasses RLS, can read all data
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Helper: call an RPC function with service-role auth
export async function rpc(fnName: string, params: Record<string, unknown> = {}) {
  const { data, error } = await supabase.rpc(fnName, params);
  if (error) throw new Error(`RPC ${fnName} failed: ${error.message}`);
  return data;
}
