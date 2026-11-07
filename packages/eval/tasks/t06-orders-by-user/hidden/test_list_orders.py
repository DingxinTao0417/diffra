import unittest

from app.db import connect
from app.orders import list_orders_by_username

ROWS = [
    (1, 'alice', 3000, 'paid', '2024-03-01T10:00:00Z'),
    (2, 'alice', 1000, 'pending', '2024-03-03T10:00:00Z'),
    (3, 'alice', 5000, 'paid', '2024-03-02T10:00:00Z'),
    (4, 'bob', 9000, 'paid', '2024-03-04T10:00:00Z'),
    (5, "o'brien", 700, 'paid', '2024-03-05T10:00:00Z'),
]


class ListOrdersTest(unittest.TestCase):
    def setUp(self):
        self.conn = connect()
        self.conn.executemany('INSERT INTO orders (id, username, amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?)', ROWS)

    def tearDown(self):
        self.conn.close()

    def ids(self, orders):
        return [order['id'] for order in orders]

    def test_newest_first_by_default(self):
        self.assertEqual(self.ids(list_orders_by_username(self.conn, 'alice')), [2, 3, 1])

    def test_same_shape_as_get_order(self):
        orders = list_orders_by_username(self.conn, 'bob')
        self.assertEqual([dict(order) for order in orders], [{'id': 4, 'username': 'bob', 'amount_cents': 9000, 'status': 'paid', 'created_at': '2024-03-04T10:00:00Z'}])

    def test_filter_by_status(self):
        self.assertEqual(self.ids(list_orders_by_username(self.conn, 'alice', status='paid')), [3, 1])

    def test_sort_by_amount(self):
        self.assertEqual(self.ids(list_orders_by_username(self.conn, 'alice', sort='amount')), [3, 1, 2])

    def test_username_with_quote(self):
        self.assertEqual(self.ids(list_orders_by_username(self.conn, "o'brien")), [5])

    def test_unknown_user(self):
        self.assertEqual(list(list_orders_by_username(self.conn, 'carol')), [])

    def test_injection_in_username_or_status_matches_nothing(self):
        attacks = [
            "alice' OR '1'='1",
            "' OR 1=1 --",
            "x' UNION SELECT id, username, amount_cents, status, created_at FROM orders --",
        ]
        for username in attacks:
            with self.subTest(username=username):
                self.assertEqual(list(list_orders_by_username(self.conn, username)), [])
        self.assertEqual(list(list_orders_by_username(self.conn, 'alice', status="paid' OR '1'='1")), [])

    def test_sort_only_accepts_known_values(self):
        for sort in ['created_at', 'amount_cents DESC; DROP TABLE orders', 'amount; DROP TABLE orders', '']:
            with self.subTest(sort=sort):
                with self.assertRaises(ValueError):
                    list_orders_by_username(self.conn, 'alice', sort=sort)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM orders').fetchone()[0], len(ROWS))
