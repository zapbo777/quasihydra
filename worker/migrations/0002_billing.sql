-- Phase 3 membership billing. Not applied to the remote D1 database.
-- Apply only after Lala approves. Prices are fixed: Basic 1900, Pro 4900, Business 14900 (USD cents).

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('square', 'paypal')),
  mode TEXT NOT NULL CHECK (mode IN ('sandbox', 'live')),
  tier TEXT NOT NULL CHECK (tier IN ('basic', 'pro', 'business')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'suspended', 'canceled', 'expired', 'failed', 'review')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents IN (1900, 4900, 14900)),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  approval_url TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_open
  ON subscriptions(user_id, mode)
  WHERE status IN ('pending', 'active', 'past_due', 'suspended');

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_id
  ON subscriptions(provider, mode, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);
