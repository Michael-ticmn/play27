#!/bin/bash
# Set up local Supabase for training after `supabase db reset`
# Creates the trainer account via the admin API (GoTrue)

LOCAL_URL="http://127.0.0.1:54321"
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

echo "Creating trainer account..."
RESULT=$(curl -s -X POST "$LOCAL_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"trainer@play27.dev","password":"enmFh#Igx5r!x36#","email_confirm":true,"user_metadata":{"display_name":"Trainer"}}')

if echo "$RESULT" | grep -q '"id"'; then
  echo "Trainer auth user created"
else
  echo "Result: $RESULT"
fi

# Ensure profile exists (trigger may not fire on admin API create)
echo "Ensuring trainer profile..."
echo "INSERT INTO profiles (id, display_name) SELECT id, 'Trainer' FROM auth.users WHERE email = 'trainer@play27.dev' ON CONFLICT (id) DO NOTHING;" | npx supabase db query 2>&1 | grep -q "INSERT" && echo "Trainer profile ready" || echo "Profile may already exist"
