CREATE TABLE shipping_rates (
  department TEXT NOT NULL, province TEXT NOT NULL, district TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK(cents BETWEEN 0 AND 1000000),
  PRIMARY KEY(department, province, district)
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, attempt TEXT UNIQUE NOT NULL, customer TEXT NOT NULL,
  total INTEGER NOT NULL, mp_id TEXT UNIQUE, checkout_url TEXT,
  state TEXT NOT NULL DEFAULT 'creating', provider_updated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
