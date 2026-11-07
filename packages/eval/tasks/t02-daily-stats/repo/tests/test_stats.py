import unittest
from datetime import timedelta, timezone

from app.stats import daily_counts, daily_totals

SHANGHAI = timezone(timedelta(hours=8))


class DailyStatsTest(unittest.TestCase):
    def test_sums_amounts_and_counts_per_day(self):
        orders = [
            {'id': 1, 'amount_cents': 1200, 'created_at': '2024-03-01T04:00:00+00:00'},
            {'id': 2, 'amount_cents': 800, 'created_at': '2024-03-01T05:30:00+00:00'},
            {'id': 3, 'amount_cents': 500, 'created_at': '2024-03-02T06:00:00+00:00'},
        ]
        self.assertEqual(daily_totals(orders, SHANGHAI), {'2024-03-01': 2000, '2024-03-02': 500})
        self.assertEqual(daily_counts(orders, SHANGHAI), {'2024-03-01': 2, '2024-03-02': 1})

    def test_empty(self):
        self.assertEqual(daily_totals([], SHANGHAI), {})
        self.assertEqual(daily_counts([], SHANGHAI), {})
