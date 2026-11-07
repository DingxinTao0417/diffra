import csv
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent.parent / 'data' / 'users.csv'


def load_users(path=DATA_FILE):
    """读运营后台导出的用户表。导出的文件可能带 UTF-8 BOM，用 utf-8-sig 读。"""
    with open(path, encoding='utf-8-sig', newline='') as handle:
        return [{'id': int(row['id']), 'name': row['name'], 'email': row['email']} for row in csv.DictReader(handle)]
