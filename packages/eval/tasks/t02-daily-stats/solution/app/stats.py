from collections import defaultdict
from datetime import datetime


def _business_day(created_at, tz):
    return datetime.fromisoformat(created_at).astimezone(tz).date().isoformat()


def daily_totals(orders, tz):
    """按业务时区的自然日汇总订单金额。tz 是 tzinfo；返回 {'YYYY-MM-DD': 金额（分）}，按日期升序。"""
    totals = defaultdict(int)
    for order in orders:
        totals[_business_day(order['created_at'], tz)] += order['amount_cents']
    return dict(sorted(totals.items()))


def daily_counts(orders, tz):
    """按业务时区的自然日统计订单数。tz 是 tzinfo；返回 {'YYYY-MM-DD': 订单数}，按日期升序。"""
    counts = defaultdict(int)
    for order in orders:
        counts[_business_day(order['created_at'], tz)] += 1
    return dict(sorted(counts.items()))
