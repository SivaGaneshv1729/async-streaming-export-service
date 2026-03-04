-- ─────────────────────────────────────────────────────────────────────────────
-- init.sql  – Idempotent schema creation + 10M row seed
-- Mounted into /docker-entrypoint-initdb.d/ so PostgreSQL runs it on first start
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Schema ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
    id               SERIAL                      PRIMARY KEY,
    name             VARCHAR(255)                NOT NULL,
    email            VARCHAR(255)                UNIQUE NOT NULL,
    signup_date      TIMESTAMP WITH TIME ZONE    DEFAULT CURRENT_TIMESTAMP,
    country_code     CHAR(2)                     NOT NULL,
    subscription_tier VARCHAR(50)               DEFAULT 'free',
    lifetime_value   NUMERIC(10, 2)             DEFAULT 0.00
);

-- ── Indexes for efficient filtering ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_country_code      ON public.users(country_code);
CREATE INDEX IF NOT EXISTS idx_users_subscription_tier ON public.users(subscription_tier);
CREATE INDEX IF NOT EXISTS idx_users_lifetime_value    ON public.users(lifetime_value);

-- ── Idempotent Seed (only if table is empty) ──────────────────────────────────
DO $$
DECLARE
    existing_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO existing_count FROM public.users;

    IF existing_count = 0 THEN
        RAISE NOTICE '[init] Table is empty – seeding 10,000,000 rows...';

        INSERT INTO public.users (name, email, signup_date, country_code, subscription_tier, lifetime_value)
        SELECT
            'User_' || gs::TEXT                                                        AS name,
            'user_' || gs::TEXT || '@example.com'                                      AS email,
            NOW() - (INTERVAL '1 day' * (random() * 1825)::INT)                       AS signup_date,
            (ARRAY['US','GB','DE','FR','IN','AU','CA','BR','JP','SG'])[floor(random()*10+1)::INT]
                                                                                       AS country_code,
            (ARRAY['free','basic','premium','enterprise'])[floor(random()*4+1)::INT]   AS subscription_tier,
            ROUND((random() * 9999)::NUMERIC, 2)                                       AS lifetime_value
        FROM generate_series(1, 10000000) AS gs;

        RAISE NOTICE '[init] Seeding complete – 10,000,000 rows inserted.';
    ELSE
        RAISE NOTICE '[init] Table already has % rows – skipping seed.', existing_count;
    END IF;
END
$$;
