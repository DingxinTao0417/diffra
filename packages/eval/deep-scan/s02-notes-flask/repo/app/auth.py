import hashlib
from functools import wraps

from flask import Blueprint, abort, jsonify, request, session

from app.db import get_db

auth = Blueprint('auth', __name__)


def hash_password(password):
    return hashlib.md5(password.encode('utf-8')).hexdigest()


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if 'user_id' not in session:
            abort(401)
        return view(*args, **kwargs)

    return wrapper


def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if session.get('role') != 'admin':
            abort(403)
        return view(*args, **kwargs)

    return wrapper


@auth.post('/register')
def register():
    data = request.get_json()
    db = get_db()
    invite = db.execute('SELECT code FROM invites WHERE code = ? AND used = 0', (data['invite'],)).fetchone()
    if invite is None:
        abort(403)
    db.execute('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)', (data['email'], hash_password(data['password']), 'member'))
    db.execute('UPDATE invites SET used = 1 WHERE code = ?', (invite['code'],))
    db.commit()
    return jsonify({'ok': True}), 201


@auth.post('/login')
def login():
    data = request.get_json()
    user = get_db().execute('SELECT id, role, password_hash FROM users WHERE email = ?', (data['email'],)).fetchone()
    if user is None or user['password_hash'] != hash_password(data['password']):
        abort(401)
    session['user_id'] = user['id']
    session['role'] = user['role']
    return jsonify({'ok': True})
