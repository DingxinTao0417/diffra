import tempfile
import unittest
from pathlib import Path

from app.users import load_users

EXPECTED = [
    {'id': 1, 'name': '张三', 'email': 'zhangsan@example.com'},
    {'id': 2, 'name': '李四', 'email': 'lisi@example.com'},
    {'id': 3, 'name': '王五', 'email': 'wangwu@example.com'},
]
CONTENT = 'id,name,email\n1,张三,zhangsan@example.com\n2,李四,lisi@example.com\n3,王五,wangwu@example.com\n'


class LoadUsersTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.directory.cleanup()

    def write(self, data):
        path = Path(self.directory.name) / 'users.csv'
        path.write_bytes(data)
        return path

    def test_reads_exported_file(self):
        self.assertEqual(load_users(), EXPECTED)

    def test_with_bom_and_crlf(self):
        path = self.write(b'\xef\xbb\xbf' + CONTENT.replace('\n', '\r\n').encode('utf-8'))
        self.assertEqual(load_users(path), EXPECTED)

    def test_without_bom(self):
        self.assertEqual(load_users(self.write(CONTENT.encode('utf-8'))), EXPECTED)
