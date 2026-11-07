import unittest
from datetime import timedelta, timezone

from app.stats import daily_counts, daily_totals

SHANGHAI = timezone(timedelta(hours=8))
NEW_YORK_WINTER = timezone(timedelta(hours=-5))


class BusinessDayTest(unittest.TestCase):
    def test_after_midnight_in_business_timezone_counts_as_next_day(self):
        orders = [
            {'id': 1, 'amount_cents': 1000, 'created_at': '2024-03-01T15:59:59+00:00'},
            {'id': 2, 'amount_cents': 2000, 'created_at': '2024-03-01T16:00:00+00:00'},
            {'id': 3, 'amount_cents': 4000, 'created_at': '2024-03-01T16:30:00Z'},
        ]
        self.assertEqual(daily_totals(orders, SHANGHAI), {'2024-03-01': 1000, '2024-03-02': 6000})
        self.assertEqual(daily_counts(orders, SHANGHAI), {'2024-03-01': 1, '2024-03-02': 2})

    def test_timestamps_with_other_offsets(self):
        orders = [
            {'id': 1, 'amount_cents': 500, 'created_at': '2024-03-02T00:10:00+08:00'},
            {'id': 2, 'amount_cents': 700, 'created_at': '2024-03-01T23:50:00+08:00'},
            {'id': 3, 'amount_cents': 900, 'created_at': '2024-03-01T12:30:00-05:00'},
        ]
        self.assertEqual(daily_totals(orders, SHANGHAI), {'2024-03-01': 700, '2024-03-02': 1400})
        self.assertEqual(daily_counts(orders, SHANGHAI), {'2024-03-01': 1, '2024-03-02': 2})

    def test_business_timezone_behind_utc(self):
        orders = [{'id': 1, 'amount_cents': 300, 'created_at': '2024-01-10T03:00:00Z'}]
        self.assertEqual(daily_totals(orders, NEW_YORK_WINTER), {'2024-01-09': 300})
        self.assertEqual(daily_counts(orders, NEW_YORK_WINTER), {'2024-01-09': 1})

    def test_sorted_by_day(self):
        orders = [
            {'id': 1, 'amount_cents': 100, 'created_at': '2024-03-03T02:00:00Z'},
            {'id': 2, 'amount_cents': 100, 'created_at': '2024-02-29T17:00:00Z'},
        ]
        self.assertEqual(list(daily_totals(orders, SHANGHAI)), ['2024-03-01', '2024-03-03'])
