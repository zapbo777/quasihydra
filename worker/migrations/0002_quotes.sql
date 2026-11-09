-- QUASI Quotation Maker for cleaners.
-- Stores only what the quote form needs: the cleaner's business name and own
-- prices, and per quote the customer name, type of clean, home size and price.
-- No customer phone, email, address or payment data is stored.

CREATE TABLE IF NOT EXISTS cleaner_profiles (
  user_id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  prices_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  clean_type TEXT NOT NULL,
  home_size TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quotes_user_created ON quotes(user_id, created_at DESC);
