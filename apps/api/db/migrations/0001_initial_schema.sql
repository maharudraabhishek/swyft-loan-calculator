-- Initial Phase 2 schema. Runs as swyft_owner, which owns every object.
-- The API connects as swyft_app: no ownership, no BYPASSRLS, RLS on every table.

-- Nobody but the owner may create objects in public (PostgreSQL <15 default allowed it).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA app;
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA app, auth FROM PUBLIC;
GRANT USAGE ON SCHEMA app, auth TO swyft_app;
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default; stop that for every
-- function this role creates now or in later migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE swyft_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Users (written only by auth functions)
-- ---------------------------------------------------------------------------
CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider text NOT NULL CHECK (identity_provider IN ('google.com', 'dev-local')),
  identity_subject text NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 128),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  email_verified boolean NOT NULL,
  display_name text CHECK (length(display_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (identity_provider, identity_subject)
);

-- ---------------------------------------------------------------------------
-- Lenders and fee signatures. owner_user_id NULL = built-in preset (read-only).
-- ---------------------------------------------------------------------------
CREATE TABLE app.lenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES app.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  website_url text CHECK (website_url ~ '^https://[^\s]{1,240}$'),
  logo_object_key text CHECK (length(logo_object_key) <= 300),
  logo_content_type text CHECK (logo_content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  logo_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((logo_object_key IS NULL) = (logo_content_type IS NULL))
);
CREATE UNIQUE INDEX lenders_preset_name_key ON app.lenders (lower(name)) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX lenders_owner_name_key ON app.lenders (owner_user_id, lower(name)) WHERE owner_user_id IS NOT NULL;

CREATE TABLE app.fee_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES app.users (id) ON DELETE CASCADE,
  lender_id uuid NOT NULL REFERENCES app.lenders (id) ON DELETE CASCADE,
  source_fee_signature_id uuid REFERENCES app.fee_signatures (id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  commission_model text NOT NULL CHECK (commission_model IN ('capitalised', 'overs', 'loaded', 'daily_interest')),
  interest_method text NOT NULL CHECK (interest_method IN ('monthly', 'daily')),
  payment_timing text NOT NULL CHECK (payment_timing IN ('advance', 'arrears')),
  default_commission_rate numeric(12, 10) CHECK (default_commission_rate BETWEEN 0 AND 1),
  max_commission_rate numeric(12, 10) CHECK (max_commission_rate BETWEEN 0 AND 1),
  base_commission numeric(14, 2) CHECK (base_commission >= 0),
  overs_share numeric(12, 10) CHECK (overs_share BETWEEN 0 AND 1),
  gst_rate numeric(12, 10) CHECK (gst_rate BETWEEN 0 AND 1),
  loading_factor numeric(12, 10) CHECK (loading_factor BETWEEN 0 AND 1),
  rate_markup_factor numeric(12, 10) CHECK (rate_markup_factor BETWEEN 0 AND 1),
  monthly_fee numeric(14, 2) NOT NULL DEFAULT 0 CHECK (monthly_fee >= 0),
  sliding_fee numeric(14, 2) NOT NULL DEFAULT 0 CHECK (sliding_fee >= 0),
  max_broker_origination numeric(14, 2) CHECK (max_broker_origination >= 0),
  -- Lender fees: absent (both NULL) or an amount with its default financing.
  establishment_fee numeric(14, 2) CHECK (establishment_fee >= 0),
  establishment_financed boolean,
  -- Autopay/Metro: lender fee rises dollar-for-dollar with broker origination up to this cap.
  establishment_fee_max numeric(14, 2) CHECK (establishment_fee_max >= establishment_fee),
  ppsr_registration_fee numeric(14, 2) CHECK (ppsr_registration_fee >= 0),
  ppsr_registration_financed boolean,
  ppsr_search_fee numeric(14, 2) CHECK (ppsr_search_fee >= 0),
  ppsr_search_financed boolean,
  private_sale_fee numeric(14, 2) CHECK (private_sale_fee >= 0),
  private_sale_financed boolean,
  -- Incremented on every edit and recorded in quote snapshots.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Each commission model carries exactly the parameters its formula needs.
  CONSTRAINT fee_signatures_model_parameters CHECK (
    (commission_model = 'overs') = (base_commission IS NOT NULL)
    AND (commission_model = 'overs') = (overs_share IS NOT NULL)
    AND (commission_model = 'overs') = (gst_rate IS NOT NULL)
    AND (commission_model = 'loaded') = (loading_factor IS NOT NULL)
    AND (commission_model = 'daily_interest') = (rate_markup_factor IS NOT NULL)
    AND (commission_model = 'daily_interest') = (interest_method = 'daily')
    AND (interest_method <> 'daily' OR payment_timing = 'arrears')
  ),
  CONSTRAINT fee_signatures_fee_pairs CHECK (
    (establishment_fee IS NULL) = (establishment_financed IS NULL)
    AND (ppsr_registration_fee IS NULL) = (ppsr_registration_financed IS NULL)
    AND (ppsr_search_fee IS NULL) = (ppsr_search_financed IS NULL)
    AND (private_sale_fee IS NULL) = (private_sale_financed IS NULL)
    AND (establishment_fee_max IS NULL OR establishment_fee IS NOT NULL)
  ),
  CONSTRAINT fee_signatures_commission_cap CHECK (
    default_commission_rate IS NULL OR max_commission_rate IS NULL
    OR default_commission_rate <= max_commission_rate
  )
);
CREATE INDEX fee_signatures_owner_idx ON app.fee_signatures (owner_user_id);
CREATE INDEX fee_signatures_lender_idx ON app.fee_signatures (lender_id);
CREATE INDEX fee_signatures_source_idx ON app.fee_signatures (source_fee_signature_id);

-- ---------------------------------------------------------------------------
-- Deals, quote logs, quotes. Composite (id, owner) keys keep a whole tree
-- under one owner even if application code passes a wrong owner.
-- ---------------------------------------------------------------------------
CREATE TABLE app.deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND name = btrim(name)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id)
);
CREATE INDEX deals_owner_updated_idx ON app.deals (owner_user_id, updated_at DESC, id DESC);

-- The brief's Quote Log is the history of one deal: exactly one log per deal,
-- created with the deal.
CREATE TABLE app.quote_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  deal_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (deal_id, owner_user_id) REFERENCES app.deals (id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX quote_logs_owner_idx ON app.quote_logs (owner_user_id);

CREATE TABLE app.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  quote_log_id uuid NOT NULL,
  fee_signature_id uuid REFERENCES app.fee_signatures (id) ON DELETE SET NULL,
  -- Immutable, server-calculated snapshot (no UPDATE grant on these columns).
  lender_name text NOT NULL CHECK (length(lender_name) BETWEEN 1 AND 120),
  fee_signature_name text NOT NULL CHECK (length(fee_signature_name) BETWEEN 1 AND 120),
  fee_signature_version integer NOT NULL CHECK (fee_signature_version >= 1),
  commission_model text NOT NULL CHECK (commission_model IN ('capitalised', 'overs', 'loaded', 'daily_interest')),
  interest_method text NOT NULL CHECK (interest_method IN ('monthly', 'daily')),
  payment_timing text NOT NULL CHECK (payment_timing IN ('advance', 'arrears')),
  asset_description text NOT NULL DEFAULT '' CHECK (length(asset_description) <= 200),
  finance_amount numeric(14, 2) NOT NULL CHECK (finance_amount > 0),
  term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 600),
  balloon numeric(14, 2) NOT NULL CHECK (balloon >= 0),
  base_rate numeric(12, 10) NOT NULL CHECK (base_rate >= 0),
  contract_rate numeric(12, 10) CHECK (contract_rate >= 0),
  commission_rate numeric(12, 10) CHECK (commission_rate BETWEEN 0 AND 1),
  comparison_rate numeric(12, 10),
  lender_fee numeric(14, 2) NOT NULL CHECK (lender_fee >= 0),
  origination_fee numeric(14, 2) NOT NULL CHECK (origination_fee >= 0),
  monthly_fee numeric(14, 2) NOT NULL CHECK (monthly_fee >= 0),
  upfront_fees numeric(14, 2) NOT NULL CHECK (upfront_fees >= 0),
  net_amount_financed numeric(14, 2) NOT NULL,
  amount_financed numeric(14, 2) NOT NULL,
  monthly_payment numeric(14, 2) NOT NULL,
  gross_monthly_payment numeric(14, 2) NOT NULL,
  commission numeric(14, 2),
  total_hiring numeric(14, 2) NOT NULL,
  calculation_input jsonb NOT NULL CHECK (jsonb_typeof(calculation_input) = 'object'),
  calculation_result jsonb NOT NULL CHECK (jsonb_typeof(calculation_result) = 'object'),
  fee_signature_snapshot jsonb NOT NULL CHECK (jsonb_typeof(fee_signature_snapshot) = 'object'),
  engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 40),
  -- Retry safety: a repeated Idempotency-Key returns the original quote.
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  -- Mutable annotation.
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key),
  FOREIGN KEY (quote_log_id, owner_user_id) REFERENCES app.quote_logs (id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX quotes_log_created_idx ON app.quotes (quote_log_id, created_at, id);
CREATE INDEX quotes_fee_signature_idx ON app.quotes (fee_signature_id);

-- ---------------------------------------------------------------------------
-- Authentication (no table privileges for swyft_app; functions only)
-- ---------------------------------------------------------------------------
CREATE TABLE auth.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  browser_secret_hash bytea NOT NULL CHECK (octet_length(browser_secret_hash) = 32),
  provider_session_id text NOT NULL CHECK (length(provider_session_id) BETWEEN 1 AND 2048),
  desktop_redirect_uri text NOT NULL
    CHECK (desktop_redirect_uri ~ '^http://(127\.0\.0\.1|\[::1\]):[0-9]{4,5}/callback$'),
  desktop_state text NOT NULL CHECK (desktop_state ~ '^[A-Za-z0-9_-]{22,128}$'),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  user_id uuid REFERENCES app.users (id) ON DELETE CASCADE,
  code_hash bytea UNIQUE CHECK (octet_length(code_hash) = 32),
  code_expires_at timestamptz,
  code_consumed_at timestamptz
);
CREATE INDEX login_attempts_expires_idx ON auth.login_attempts (expires_at);

CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  access_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(access_token_hash) = 32),
  access_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('logout', 'refresh_token_reuse', 'administrative')),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX sessions_user_idx ON auth.sessions (user_id);

CREATE TABLE auth.refresh_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  session_id uuid NOT NULL REFERENCES auth.sessions (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  -- Set when a grace re-rotation retires this token unused; presenting it later is replay.
  superseded_at timestamptz,
  CHECK (superseded_at IS NULL OR consumed_at IS NOT NULL)
);
CREATE INDEX refresh_tokens_session_idx ON auth.refresh_tokens (session_id);

-- ---------------------------------------------------------------------------
-- Auth functions. SECURITY DEFINER with search_path pinned to pg_catalog then
-- pg_temp, and every relation schema-qualified, so callers cannot shadow objects.
-- ---------------------------------------------------------------------------

-- Identity for RLS: derived inside the database from the request's access-token hash.
CREATE FUNCTION auth.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.user_id
  FROM auth.sessions s
  JOIN app.users u ON u.id = s.user_id
  WHERE s.access_token_hash = decode(nullif(current_setting('app.access_token_hash', true), ''), 'hex')
    AND s.revoked_at IS NULL
    AND s.access_expires_at > now()
    AND s.absolute_expires_at > now()
    AND u.disabled_at IS NULL
$$;

CREATE FUNCTION auth.resolve_access_token(p_access_hash bytea)
RETURNS TABLE (user_id uuid, session_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.user_id, s.id
  FROM auth.sessions s
  JOIN app.users u ON u.id = s.user_id
  WHERE s.access_token_hash = p_access_hash
    AND s.revoked_at IS NULL
    AND s.access_expires_at > now()
    AND s.absolute_expires_at > now()
    AND u.disabled_at IS NULL
$$;

CREATE FUNCTION auth.begin_login(
  p_browser_secret_hash bytea,
  p_provider_session_id text,
  p_redirect_uri text,
  p_desktop_state text,
  p_code_challenge text,
  p_ttl interval
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  -- The start endpoint is unauthenticated; purge expired attempts on every write.
  DELETE FROM auth.login_attempts WHERE expires_at < now() - interval '1 hour';
  INSERT INTO auth.login_attempts (
    browser_secret_hash, provider_session_id, desktop_redirect_uri,
    desktop_state, code_challenge, expires_at
  ) VALUES (
    p_browser_secret_hash, p_provider_session_id, p_redirect_uri,
    p_desktop_state, p_code_challenge, now() + p_ttl
  ) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Pending attempt details, only for the browser that started it.
CREATE FUNCTION auth.pending_login(p_attempt_id uuid, p_browser_secret_hash bytea)
RETURNS TABLE (provider_session_id text, redirect_uri text, desktop_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.provider_session_id, a.desktop_redirect_uri, a.desktop_state
  FROM auth.login_attempts a
  WHERE a.id = p_attempt_id
    AND a.browser_secret_hash = p_browser_secret_hash
    AND a.completed_at IS NULL
    AND a.expires_at > now()
$$;

CREATE FUNCTION auth.complete_login(
  p_attempt_id uuid,
  p_browser_secret_hash bytea,
  p_identity_provider text,
  p_identity_subject text,
  p_email text,
  p_email_verified boolean,
  p_display_name text,
  p_code_hash bytea,
  p_code_ttl interval
) RETURNS TABLE (redirect_uri text, desktop_state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_redirect text;
  v_state text;
  v_user uuid;
  v_disabled timestamptz;
BEGIN
  UPDATE auth.login_attempts a
  SET completed_at = now()
  WHERE a.id = p_attempt_id
    AND a.browser_secret_hash = p_browser_secret_hash
    AND a.completed_at IS NULL
    AND a.expires_at > now()
  RETURNING a.desktop_redirect_uri, a.desktop_state INTO v_redirect, v_state;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO app.users AS u (identity_provider, identity_subject, email, email_verified, display_name)
  VALUES (p_identity_provider, p_identity_subject, p_email, p_email_verified, p_display_name)
  ON CONFLICT (identity_provider, identity_subject) DO UPDATE
    SET email = EXCLUDED.email,
        email_verified = EXCLUDED.email_verified,
        display_name = EXCLUDED.display_name,
        last_sign_in_at = now()
  RETURNING u.id, u.disabled_at INTO v_user, v_disabled;
  IF v_disabled IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE auth.login_attempts a
  SET user_id = v_user, code_hash = p_code_hash, code_expires_at = now() + p_code_ttl
  WHERE a.id = p_attempt_id;
  RETURN QUERY SELECT v_redirect, v_state;
END
$$;

CREATE FUNCTION auth.exchange_code(
  p_code_hash bytea,
  p_code_challenge text,
  p_redirect_uri text,
  p_access_hash bytea,
  p_access_ttl interval,
  p_refresh_hash bytea,
  p_idle_ttl interval,
  p_absolute_ttl interval
) RETURNS TABLE (
  session_id uuid, user_id uuid, access_expires_at timestamptz, refresh_expires_at timestamptz,
  email text, display_name text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_challenge text;
  v_redirect text;
  v_session uuid;
  v_access_expires timestamptz;
  v_idle_expires timestamptz;
BEGIN
  -- Consume first: a code gets exactly one exchange attempt, right or wrong.
  UPDATE auth.login_attempts a
  SET code_consumed_at = now()
  WHERE a.code_hash = p_code_hash
    AND a.code_consumed_at IS NULL
    AND a.code_expires_at > now()
  RETURNING a.user_id, a.code_challenge, a.desktop_redirect_uri
  INTO v_user, v_challenge, v_redirect;
  IF NOT FOUND OR v_challenge <> p_code_challenge OR v_redirect <> p_redirect_uri THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.users u WHERE u.id = v_user AND u.disabled_at IS NULL) THEN
    RETURN;
  END IF;

  INSERT INTO auth.sessions AS s (user_id, access_token_hash, access_expires_at, idle_expires_at, absolute_expires_at)
  VALUES (v_user, p_access_hash, now() + p_access_ttl,
          least(now() + p_idle_ttl, now() + p_absolute_ttl), now() + p_absolute_ttl)
  RETURNING s.id, s.access_expires_at, s.idle_expires_at
  INTO v_session, v_access_expires, v_idle_expires;
  INSERT INTO auth.refresh_tokens (token_hash, session_id) VALUES (p_refresh_hash, v_session);
  -- The profile comes back in the same transaction, so nothing can fail after the commit.
  RETURN QUERY
    SELECT v_session, v_user, v_access_expires, v_idle_expires, u.email, u.display_name
    FROM app.users u WHERE u.id = v_user;
END
$$;

-- Outcomes: rotated | invalid | reused | expired. Returns a row instead of raising so
-- that a reuse-triggered revocation commits.
CREATE FUNCTION auth.refresh_session(
  p_refresh_hash bytea,
  p_access_hash bytea,
  p_access_ttl interval,
  p_new_refresh_hash bytea,
  p_idle_ttl interval,
  p_reuse_grace interval
) RETURNS TABLE (
  outcome text, session_id uuid, user_id uuid, access_expires_at timestamptz,
  refresh_expires_at timestamptz, email text, display_name text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_session uuid;
  v_consumed timestamptz;
  v_superseded timestamptz;
  v_user uuid;
  v_access_expires timestamptz;
  v_idle_expires timestamptz;
BEGIN
  SELECT t.session_id INTO v_session FROM auth.refresh_tokens t WHERE t.token_hash = p_refresh_hash;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;
  -- Serialize refreshes of one session, then read consumption state under the lock.
  PERFORM 1 FROM auth.sessions s WHERE s.id = v_session FOR UPDATE;
  SELECT t.consumed_at, t.superseded_at INTO v_consumed, v_superseded
  FROM auth.refresh_tokens t WHERE t.token_hash = p_refresh_hash;

  IF v_consumed IS NOT NULL THEN
    -- A consumed token is replay, unless the response carrying its successor was lost:
    -- within the grace period, while no later token has been used, and never for a token
    -- that a grace rotation already retired. The retired successors are kept (not deleted)
    -- so that if the real client later presents one, the session is revoked as replay.
    IF v_superseded IS NULL AND v_consumed > now() - p_reuse_grace AND NOT EXISTS (
      SELECT 1 FROM auth.refresh_tokens t
      WHERE t.session_id = v_session AND t.consumed_at IS NOT NULL AND t.created_at >= v_consumed
    ) THEN
      UPDATE auth.refresh_tokens t
      SET consumed_at = now(), superseded_at = now()
      WHERE t.session_id = v_session AND t.consumed_at IS NULL;
    ELSE
      UPDATE auth.sessions s
      SET revoked_at = now(), revoke_reason = 'refresh_token_reuse'
      WHERE s.id = v_session AND s.revoked_at IS NULL;
      RETURN QUERY SELECT 'reused'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text;
      RETURN;
    END IF;
  ELSE
    UPDATE auth.refresh_tokens t SET consumed_at = now() WHERE t.token_hash = p_refresh_hash;
  END IF;

  UPDATE auth.sessions s
  SET access_token_hash = p_access_hash,
      access_expires_at = least(now() + p_access_ttl, s.absolute_expires_at),
      idle_expires_at = least(now() + p_idle_ttl, s.absolute_expires_at),
      last_refreshed_at = now()
  WHERE s.id = v_session
    AND s.revoked_at IS NULL
    AND s.idle_expires_at > now()
    AND s.absolute_expires_at > now()
    AND EXISTS (SELECT 1 FROM app.users u WHERE u.id = s.user_id AND u.disabled_at IS NULL)
  RETURNING s.user_id, s.access_expires_at, s.idle_expires_at
  INTO v_user, v_access_expires, v_idle_expires;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO auth.refresh_tokens (token_hash, session_id) VALUES (p_new_refresh_hash, v_session);
  RETURN QUERY
    SELECT 'rotated'::text, v_session, v_user, v_access_expires, v_idle_expires, u.email, u.display_name
    FROM app.users u WHERE u.id = v_user;
END
$$;

-- Possession of any refresh token of the session is sufficient to end it.
CREATE FUNCTION auth.revoke_session(p_refresh_hash bytea) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE auth.sessions s
  SET revoked_at = now(), revoke_reason = 'logout'
  FROM auth.refresh_tokens t
  WHERE t.token_hash = p_refresh_hash AND t.session_id = s.id AND s.revoked_at IS NULL;
  RETURN FOUND;
END
$$;

-- Visibility checks for policies that must look at a table's own rows. A policy that
-- queries its own table recurses; these definer functions apply the same rule explicitly.
CREATE FUNCTION auth.fee_signature_visible(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.fee_signatures f
    WHERE f.id = p_id
      AND (f.owner_user_id IS NULL OR f.owner_user_id = auth.current_user_id())
  )
$$;

CREATE FUNCTION auth.lender_visible(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.lenders l
    WHERE l.id = p_id
      AND (l.owner_user_id IS NULL OR l.owner_user_id = auth.current_user_id())
  )
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  auth.current_user_id(),
  auth.resolve_access_token(bytea),
  auth.begin_login(bytea, text, text, text, text, interval),
  auth.pending_login(uuid, bytea),
  auth.complete_login(uuid, bytea, text, text, text, boolean, text, bytea, interval),
  auth.exchange_code(bytea, text, text, bytea, interval, bytea, interval, interval),
  auth.refresh_session(bytea, bytea, interval, bytea, interval, interval),
  auth.revoke_session(bytea),
  auth.fee_signature_visible(uuid),
  auth.lender_visible(uuid)
TO swyft_app;

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled on every table. swyft_app owns none of them.
-- ---------------------------------------------------------------------------
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fee_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.quote_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self_select ON app.users FOR SELECT TO swyft_app
  USING (id = (SELECT auth.current_user_id()));

-- Presets (owner NULL) are readable by every signed-in user; write policies never
-- include the preset branch, so no user can create, change or delete a preset.
CREATE POLICY lenders_select ON app.lenders FOR SELECT TO swyft_app
  USING (owner_user_id IS NULL OR owner_user_id = (SELECT auth.current_user_id()));
CREATE POLICY lenders_insert ON app.lenders FOR INSERT TO swyft_app
  WITH CHECK (owner_user_id = (SELECT auth.current_user_id()));
CREATE POLICY lenders_update ON app.lenders FOR UPDATE TO swyft_app
  USING (owner_user_id = (SELECT auth.current_user_id()))
  WITH CHECK (owner_user_id = (SELECT auth.current_user_id()));
CREATE POLICY lenders_delete ON app.lenders FOR DELETE TO swyft_app
  USING (owner_user_id = (SELECT auth.current_user_id()));

-- References must point at rows the caller can see (own or preset).
CREATE POLICY fee_signatures_select ON app.fee_signatures FOR SELECT TO swyft_app
  USING (owner_user_id IS NULL OR owner_user_id = (SELECT auth.current_user_id()));
CREATE POLICY fee_signatures_insert ON app.fee_signatures FOR INSERT TO swyft_app
  WITH CHECK (
    owner_user_id = (SELECT auth.current_user_id())
    AND auth.lender_visible(lender_id)
    AND (source_fee_signature_id IS NULL OR auth.fee_signature_visible(source_fee_signature_id))
  );
CREATE POLICY fee_signatures_update ON app.fee_signatures FOR UPDATE TO swyft_app
  USING (owner_user_id = (SELECT auth.current_user_id()))
  WITH CHECK (
    owner_user_id = (SELECT auth.current_user_id())
    AND auth.lender_visible(lender_id)
  );
CREATE POLICY fee_signatures_delete ON app.fee_signatures FOR DELETE TO swyft_app
  USING (owner_user_id = (SELECT auth.current_user_id()));

CREATE POLICY deals_owner ON app.deals FOR ALL TO swyft_app
  USING (owner_user_id = (SELECT auth.current_user_id()))
  WITH CHECK (owner_user_id = (SELECT auth.current_user_id()));
CREATE POLICY quote_logs_owner ON app.quote_logs FOR ALL TO swyft_app
  USING (owner_user_id = (SELECT auth.current_user_id()))
  WITH CHECK (owner_user_id = (SELECT auth.current_user_id()));
CREATE POLICY quotes_owner ON app.quotes FOR ALL TO swyft_app
  USING (owner_user_id = (SELECT auth.current_user_id()))
  WITH CHECK (
    owner_user_id = (SELECT auth.current_user_id())
    AND (fee_signature_id IS NULL OR auth.fee_signature_visible(fee_signature_id))
  );

-- Auth tables: RLS enabled with no policies, and no privileges, for swyft_app.

-- ---------------------------------------------------------------------------
-- Grants. Quote calculation columns are immutable for the runtime role.
-- ---------------------------------------------------------------------------
GRANT SELECT ON app.users TO swyft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.lenders, app.fee_signatures, app.deals TO swyft_app;
GRANT SELECT, INSERT, DELETE ON app.quote_logs TO swyft_app;
GRANT SELECT, INSERT, DELETE ON app.quotes TO swyft_app;
GRANT UPDATE (notes, updated_at) ON app.quotes TO swyft_app;
