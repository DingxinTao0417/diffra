import os
import sqlite3

from flask import g

DB_PATH = os.environ.get('NOTES_DB', 'notes.db')


def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db
