CREATE TABLE IF NOT EXISTS tenders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE,             -- Unique ID (e.g. source + "_" + source_id or md5)
    source TEXT,                 -- Source of data (acebidx / pcc)
    case_number TEXT,            -- Case Number (標案案號)
    agency TEXT,                 -- Agency Name (機關名稱)
    title TEXT,                  -- Bidding Title (標案名稱)
    publish_date TEXT,           -- Announcement Date (YYYY-MM-DD for sorting)
    end_date TEXT,               -- Deadline Date (截止投標日期)
    budget INTEGER,              -- Budget amount as number for sorting (0 if secret/unannounced)
    budget_text TEXT,            -- Formatted budget amount (e.g., "19,800,000元")
    url TEXT,                    -- Announcement URL
    is_pinned INTEGER DEFAULT 0,
    is_locked INTEGER DEFAULT 0,
    is_removed INTEGER DEFAULT 0,
    is_edited INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenders_publish_date ON tenders(publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_tenders_budget ON tenders(budget DESC);

CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO users (email, username, password, role)
VALUES ('flaviochang@gamania.com', 'admin', '111111', 'admin');


