import sqlite3

SCHEMA = '''
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);
'''


def connect(path=':memory:'):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn
