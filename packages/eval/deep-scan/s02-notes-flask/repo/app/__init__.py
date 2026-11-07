import os

from flask import Flask

from app.admin import admin
from app.auth import auth
from app.notes import notes


def create_app():
    app = Flask(__name__)
    app.secret_key = os.environ['FLASK_SECRET_KEY']
    app.register_blueprint(auth)
    app.register_blueprint(notes)
    app.register_blueprint(admin)
    return app
