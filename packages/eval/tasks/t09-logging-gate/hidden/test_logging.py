import ast
import logging
import re
import unittest
from pathlib import Path

from app.importer import import_rows

ROWS = [
    {'name': '张三', 'age': '30'},
    {'name': '  ', 'age': '20'},
    {'name': '李四', 'age': 'abc'},
    {'name': '王五', 'age': '200'},
    {'age': '18'},
]


def mentions(record, number):
    return re.search(rf'(?<!\d){number}(?!\d)', record.getMessage()) is not None


def carries_exception(record):
    if record.exc_info and record.exc_info[1] is not None:
        return True
    args = record.args if isinstance(record.args, tuple) else tuple((record.args or {}).values())
    return any(isinstance(value, BaseException) for value in (*args, *vars(record).values()))


class ImporterLoggingTest(unittest.TestCase):
    def test_returns_valid_rows(self):
        self.assertEqual(import_rows(ROWS), [{'name': '张三', 'age': 30}])

    def test_failed_rows_logged_as_error_with_row_number_and_exception(self):
        with self.assertLogs('app.importer', level='ERROR') as captured:
            import_rows(ROWS)
        for number in (2, 3, 4, 5):
            matching = [record for record in captured.records if mentions(record, number)]
            self.assertTrue(matching, f'第 {number} 行失败没有记 error 日志')
            self.assertTrue(any(carries_exception(record) for record in matching), f'第 {number} 行的日志没带原始异常')

    def test_summary_logged_as_info(self):
        with self.assertLogs('app.importer', level='INFO') as captured:
            import_rows(ROWS)
        self.assertTrue(any(record.levelno == logging.INFO for record in captured.records))

    def test_progress_logged_as_debug(self):
        with self.assertLogs('app.importer', level='DEBUG') as captured:
            import_rows(ROWS)
        self.assertTrue(any(record.levelno == logging.DEBUG for record in captured.records))

    def test_no_print_left_in_app(self):
        for path in Path('app').rglob('*.py'):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            calls = [node.lineno for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'print']
            with self.subTest(path=str(path)):
                self.assertEqual(calls, [])
