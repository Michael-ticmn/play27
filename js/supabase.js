// ============================================================
// play27 — Supabase Client
// Shared initialization, auth helpers, and RPC wrapper
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const APP_VERSION = '0.11.27';

export const SUPABASE_URL = 'https://pxjkedzafalchtxmwvnl.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4amtlZHphZmFsY2h0eG13dm5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0MDI5MjMsImV4cCI6MjA5MDk3ODkyM30.3EWGJ1R-XzyjDoXHhUQEhldF2rE0Xz0Jui1SmoovPFU';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Direct-fetch RPC wrapper. Bypasses the Supabase client's .rpc()
 * which can silently hang on stale auth tokens.
 * Returns { data, error } matching the Supabase convention.
 */
export function getTokenFromStorage() {
  // Read token directly from localStorage — bypasses sb.auth.getSession() which can hang
  const storageKey = `sb-pxjkedzafalchtxmwvnl-auth-token`;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.access_token || null;
    }
  } catch (e) { /* ignore */ }
  return null;
}

export async function ensureProfile(userId, displayName) {
  const token = getTokenFromStorage();
  if (!token) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ id: userId, display_name: displayName || 'Player' })
    });
  } catch (e) { /* best effort */ }
}

export async function rpc(fnName, params = {}) {
  const token = getTokenFromStorage();

  if (!token) {
    return { data: null, error: { message: 'Not authenticated — please sign in again' } };
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
    const text = await resp.text();
    let result = null;
    if (text) {
      try { result = JSON.parse(text); } catch (e) { result = text; }
    }
    console.log(`[rpc] ${fnName}`, resp.status, result);

    if (!resp.ok) {
      const msg = result?.message || result?.msg || (typeof result === 'string' ? result : JSON.stringify(result)) || 'RPC failed';
      return { data: null, error: { message: msg, code: result?.code } };
    }

    return { data: result, error: null };
  } catch (err) {
    return { data: null, error: { message: err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Network error') } };
  }
}
