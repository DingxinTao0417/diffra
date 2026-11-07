ORDER_COLUMNS = 'id, username, amount_cents, status, created_at'


def get_order(conn, order_id):
    row = conn.execute(f'SELECT {ORDER_COLUMNS} FROM orders WHERE id = ?', (order_id,)).fetchone()
    return dict(row) if row else None
