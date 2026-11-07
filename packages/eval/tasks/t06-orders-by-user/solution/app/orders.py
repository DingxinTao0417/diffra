ORDER_COLUMNS = 'id, username, amount_cents, status, created_at'
# 排序方式只认这几个值，对应的 SQL 片段是写死的，不拼接外部输入
SORT_CLAUSES = {
    'newest': 'created_at DESC',
    'amount': 'amount_cents DESC',
}


def get_order(conn, order_id):
    row = conn.execute(f'SELECT {ORDER_COLUMNS} FROM orders WHERE id = ?', (order_id,)).fetchone()
    return dict(row) if row else None


def list_orders_by_username(conn, username, status=None, sort='newest'):
    order_by = SORT_CLAUSES.get(sort)
    if order_by is None:
        raise ValueError(f'不支持的排序方式：{sort!r}')
    sql = f'SELECT {ORDER_COLUMNS} FROM orders WHERE username = ?'
    params = [username]
    if status is not None:
        sql += ' AND status = ?'
        params.append(status)
    rows = conn.execute(f'{sql} ORDER BY {order_by}', params).fetchall()
    return [dict(row) for row in rows]
