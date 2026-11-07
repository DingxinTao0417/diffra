import os
import pickle

from flask import Blueprint, abort, jsonify, request, send_file, session

from app import repository
from app.auth import login_required

notes = Blueprint('notes', __name__)

ATTACHMENT_DIR = os.environ.get('ATTACHMENT_DIR', 'attachments')


@notes.get('/notes')
@login_required
def list_notes():
    return jsonify(repository.list_notes(session['user_id']))


@notes.get('/notes/<int:note_id>')
@login_required
def get_note(note_id):
    note = repository.get_note(note_id)
    if note is None:
        abort(404)
    return jsonify(note)


@notes.get('/notes/search')
@login_required
def search():
    keyword = request.args.get('q', '')
    return jsonify(repository.search_notes(session['user_id'], keyword))


@notes.get('/attachments')
@login_required
def download_attachment():
    name = request.args.get('name', '')
    return send_file(os.path.join(ATTACHMENT_DIR, str(session['user_id']), name))


@notes.post('/notes/import')
@login_required
def import_notes():
    items = pickle.loads(request.get_data())
    for item in items[:500]:
        repository.create_note(session['user_id'], item['title'], item['body'])
    return jsonify({'imported': min(len(items), 500)})
