import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHandler } from '../src/handlers.ts'
import { UserRepository } from '../src/user-repository.ts'
import { UserService } from '../src/user-service.ts'

function setup() {
  const repository = new UserRepository()
  repository.save({ id: 'u1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash-1' })
  repository.save({ id: 'u2', email: 'Bob@Example.COM', name: 'Bob', passwordHash: 'hash-2' })
  const service = new UserService(repository)
  return { repository, service, handle: createHandler(service) }
}

test('仓储层按邮箱查找，不区分大小写、忽略首尾空格', () => {
  const { repository } = setup()
  assert.equal(repository.findByEmail('alice@example.com')?.id, 'u1')
  assert.equal(repository.findByEmail('  ALICE@example.com ')?.id, 'u1')
  assert.equal(repository.findByEmail('bob@example.com')?.id, 'u2')
  assert.ok(repository.findByEmail('carol@example.com') == null)
})

test('服务层返回的用户不带密码哈希', () => {
  const { service } = setup()
  const user = service.findUserByEmail('Alice@Example.com')
  assert.equal(user?.id, 'u1')
  assert.ok(user && !('passwordHash' in user))
  assert.ok(service.findUserByEmail('nobody@example.com') == null)
})

test('GET /users?email= 找到时返回 200 和用户，不带密码哈希', () => {
  const response = setup().handle({ method: 'GET', path: '/users', query: { email: ' alice@EXAMPLE.com' } })
  assert.equal(response.status, 200)
  assert.equal((response.body as { id: string }).id, 'u1')
  assert.ok(!JSON.stringify(response.body).includes('hash-1'))
})

test('GET /users?email= 找不到返回 404', () => {
  assert.equal(setup().handle({ method: 'GET', path: '/users', query: { email: 'nobody@example.com' } }).status, 404)
})

test('没传邮箱或格式不对返回 400', () => {
  const { handle } = setup()
  for (const query of [{}, { email: '' }, { email: '   ' }, { email: 'not-an-email' }]) {
    assert.equal(handle({ method: 'GET', path: '/users', query }).status, 400, JSON.stringify(query))
  }
})

test('原来的按 id 查询不受影响', () => {
  const response = setup().handle({ method: 'GET', path: '/users/u2', query: {} })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { id: 'u2', email: 'Bob@Example.COM', name: 'Bob' })
})
