CREATE TABLE IF NOT EXISTS tenders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE,             -- Unique ID (e.g. source + "_" + source_id or md5)
    source TEXT,                 -- Source of data (acebidx / pcc)
    agency TEXT,                 -- Agency Name (機關名稱)
    title TEXT,                  -- Bidding Title (標案名稱)
    publish_date TEXT,           -- Announcement Date (YYYY-MM-DD for sorting)
    budget INTEGER,              -- Budget amount as number for sorting (0 if secret/unannounced)
    budget_text TEXT,            -- Formatted budget amount (e.g., "19,800,000元")
    url TEXT,                    -- Announcement URL
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenders_publish_date ON tenders(publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_tenders_budget ON tenders(budget DESC);
