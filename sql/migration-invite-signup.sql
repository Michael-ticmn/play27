-- Invite-only sign-up, enforced by the database.
--
-- Before this, login.js created the account first and redeemed the invite afterwards, so a
-- bad code still left a working login, and when email confirmation is on (no session after
-- sign-up) the code was never checked at all. Now:
--   1. check_invite_code() lets the sign-up page validate the code before creating anything.
--   2. A BEFORE INSERT trigger on auth.users rejects any new account whose sign-up metadata
--      doesn't carry a valid, unexpired invite code (covers direct calls to the auth API).
--   3. An AFTER INSERT trigger records the redemption, with or without email confirmation.
--
-- Every new account needs a valid code, including ones made with the admin API (pass it as
-- user_metadata.invite_code) and the dashboard's "Add user", which cannot set metadata and so
-- is refused: add people by giving them an invite code instead. (The auth server writes
-- app_metadata after the row is inserted, so it can't serve as an admin bypass here.)
-- Existing accounts are not affected. Re-runnable.

-- 1. Validate an invite code without signing in. Same messages as redeem_invite_code().
create or replace function public.check_invite_code(p_code text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_code invite_codes%rowtype;
begin
  select * into v_code from invite_codes where code = upper(btrim(coalesce(p_code, '')));
  if not found then
    raise exception 'Invalid invite code';
  end if;
  if v_code.expires_at < now() then
    raise exception 'Invite code has expired';
  end if;
  return true;
end;
$$;

grant execute on function public.check_invite_code(text) to anon, authenticated;

-- 2. Reject new accounts without a valid invite code.
create or replace function public.enforce_invite_on_signup()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_code text := upper(btrim(coalesce(new.raw_user_meta_data->>'invite_code', '')));
begin
  if v_code = '' or not exists (select 1 from invite_codes where code = v_code and expires_at > now()) then
    raise exception 'A valid play27 invite code is required to sign up';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_invite_on_signup on auth.users;
create trigger enforce_invite_on_signup
  before insert on auth.users
  for each row execute function public.enforce_invite_on_signup();

-- 3. Record the redemption as soon as the account exists.
create or replace function public.record_invite_redemption()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_code text := upper(btrim(coalesce(new.raw_user_meta_data->>'invite_code', '')));
begin
  if v_code <> '' and exists (select 1 from invite_codes where code = v_code) then
    insert into invite_redemptions (code, used_by) values (v_code, new.id)
    on conflict (code, used_by) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists record_invite_redemption on auth.users;
create trigger record_invite_redemption
  after insert on auth.users
  for each row execute function public.record_invite_redemption();
