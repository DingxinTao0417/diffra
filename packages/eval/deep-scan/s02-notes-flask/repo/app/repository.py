from app.db import get_db

NOTE_COLUMNS = 'id, user_id, title, body, created_at'


def list_notes(user_id):
    rows = get_db().execute(f'SELECT {NOTE_COLUMNS} FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', (user_id,)).fetchall()
    return [dict(row) for row in rows]


def get_note(note_id):
    row = get_db().execute(f'SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?', (note_id,)).fetchone()
    return dict(row) if row else None


def search_notes(user_id, keyword):
    sql = f"SELECT {NOTE_COLUMNS} FROM notes WHERE user_id = ? AND title LIKE '%{keyword}%' ORDER BY created_at DESC LIMIT 100"
    return [dict(row) for row in get_db().execute(sql, (user_id,)).fetchall()]


def create_note(user_id, title, body):
    db = get_db()
    db.execute('INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)', (user_id, title, body))
    db.commit()
