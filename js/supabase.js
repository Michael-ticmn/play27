// ============================================================
// play27 — Supabase Client
// Shared initialization, auth helpers, and RPC wrapper
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const APP_VERSION = '0.9.5';

export const SUPABASE_URL = 'https://pxjkedzafalchtxmwvnl.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4amtlZHphZmFsY2h0eG13dm5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0MDI5MjMsImV4cCI6MjA5MDk3ODkyM30.3EWGJ1R-XzyjDoXHhUQEhldF2rE0Xz0Jui1SmoovPFU';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Direct-fetch RPC wrapper. Bypasses the Supabase client's .rpc()
 * which can silently hang on stale auth tokens.
 * Returns { data, error } matching the Supabase convention.
 */
export async function rpc(fnName, params = {}) {
  let token;
  try {
    const session = await Promise.race([
      sb.auth.getSession(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Auth timeout')), 5000))
    ]);
    token = session.data?.session?.access_token;
  } catch (err) {
    return { data: null, error: { message: err.message || 'Auth failed' } };
  }

  if (!token) {
    return { data: null, error: { message: 'Not authenticated' } };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(params),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const result = await resp.json();
    console.log(`[rpc] ${fnName}`, resp.status, result);

    if (!resp.ok) {
      return { data: null, error: { message: result.message || result.msg || JSON.stringify(result), code: result.code } };
    }

    return { data: result, error: null };
  } catch (err) {
    return { data: null, error: { message: err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Network error') } };
  }
}
