import unittest

from app.db import connect
from app.orders import get_order


class GetOrderTest(unittest.TestCase):
    def setUp(self):
        self.conn = connect()
        self.conn.execute(
            'INSERT INTO orders (id, username, amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?)',
            (1, 'alice', 3000, 'paid', '2024-03-01T10:00:00Z'),
        )

    def tearDown(self):
        self.conn.close()

    def test_found(self):
        self.assertEqual(
            get_order(self.conn, 1),
            {'id': 1, 'username': 'alice', 'amount_cents': 3000, 'status': 'paid', 'created_at': '2024-03-01T10:00:00Z'},
        )

    def test_missing(self):
        self.assertIsNone(get_order(self.conn, 2))
