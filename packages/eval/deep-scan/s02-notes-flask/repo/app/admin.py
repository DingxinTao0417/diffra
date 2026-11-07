import random
import string
import subprocess

from flask import Blueprint, jsonify

from app.auth import admin_required
from app.db import DB_PATH, get_db

admin = Blueprint('admin', __name__, url_prefix='/admin')

BACKUP_PATH = 'backups/notes.db'


def new_invite_code():
    return ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(24))


@admin.post('/invites')
@admin_required
def create_invite():
    code = new_invite_code()
    db = get_db()
    db.execute('INSERT INTO invites (code, used) VALUES (?, 0)', (code,))
    db.commit()
    return jsonify({'code': code}), 201


@admin.post('/backup')
@admin_required
def backup():
    subprocess.run(['sqlite3', DB_PATH, f'.backup {BACKUP_PATH}'], check=True, timeout=60)
    return jsonify({'path': BACKUP_PATH})
