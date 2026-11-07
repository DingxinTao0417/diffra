from zoneinfo import ZoneInfo

from app.stats import daily_counts, daily_totals

BUSINESS_TIMEZONE = ZoneInfo('Asia/Shanghai')


def build_daily_report(orders):
    totals = daily_totals(orders, BUSINESS_TIMEZONE)
    counts = daily_counts(orders, BUSINESS_TIMEZONE)
    return [{'day': day, 'orders': counts[day], 'amount_cents': amount} for day, amount in totals.items()]
