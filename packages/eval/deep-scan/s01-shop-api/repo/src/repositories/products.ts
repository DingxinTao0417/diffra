import { pool } from '../db.ts'

export interface Product {
  id: string
  name: string
  priceCents: number
}

export async function findProduct(id: string): Promise<Product | null> {
  const result = await pool.query('SELECT id, name, price_cents AS "priceCents" FROM products WHERE id = $1', [id])
  return result.rows[0] ?? null
}

export async function searchProducts(keyword: string, sort: string): Promise<Product[]> {
  const result = await pool.query(
    `SELECT id, name, price_cents AS "priceCents" FROM products WHERE name ILIKE '%${keyword}%' ORDER BY ${sort} LIMIT 50`,
  )
  return result.rows
}
