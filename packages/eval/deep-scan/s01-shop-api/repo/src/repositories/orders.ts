import { pool } from '../db.ts'

export interface Order {
  id: string
  userId: string
  totalCents: number
  status: string
}

const COLUMNS = 'id, user_id AS "userId", total_cents AS "totalCents", status'

export async function findOrder(id: string): Promise<Order | null> {
  const result = await pool.query(`SELECT ${COLUMNS} FROM orders WHERE id = $1`, [id])
  return result.rows[0] ?? null
}

export async function listOrders(userId: string): Promise<Order[]> {
  const result = await pool.query(`SELECT ${COLUMNS} FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId])
  return result.rows
}
