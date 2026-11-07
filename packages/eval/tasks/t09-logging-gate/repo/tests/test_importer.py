import unittest

from app.importer import import_rows


class ImportRowsTest(unittest.TestCase):
    def test_skips_invalid_rows(self):
        rows = [{'name': '张三', 'age': '30'}, {'name': '', 'age': '1'}]
        self.assertEqual(import_rows(rows), [{'name': '张三', 'age': 30}])
