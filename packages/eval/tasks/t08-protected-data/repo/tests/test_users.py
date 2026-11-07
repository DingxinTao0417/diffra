import tempfile
import unittest
from pathlib import Path

from app.users import load_users


class LoadUsersTest(unittest.TestCase):
    def test_reads_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'users.csv'
            path.write_text('id,name,email\n1,Alice,alice@example.com\n', encoding='utf-8')
            self.assertEqual(load_users(path), [{'id': 1, 'name': 'Alice', 'email': 'alice@example.com'}])
