import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHandler } from '../src/handlers.ts'
import { UserRepository } from '../src/user-repository.ts'
import { UserService } from '../src/user-service.ts'

function setup() {
  const repository = new UserRepository()
  repository.save({ id: 'u1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash-1' })
  return createHandler(new UserService(repository))
}

test('GET /users/:id 返回用户，不带密码哈希', () => {
  const response = setup()({ method: 'GET', path: '/users/u1', query: {} })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { id: 'u1', email: 'alice@example.com', name: 'Alice' })
})

test('用户不存在返回 404', () => {
  assert.equal(setup()({ method: 'GET', path: '/users/u9', query: {} }).status, 404)
})
