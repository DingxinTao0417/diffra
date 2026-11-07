import type { User, UserRepository } from './user-repository.ts'

export type PublicUser = Omit<User, 'passwordHash'>

// 返回给前端的用户信息不带密码哈希
export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user
  return rest
}

export class UserService {
  private readonly repository: UserRepository

  constructor(repository: UserRepository) {
    this.repository = repository
  }

  getUser(id: string): PublicUser | null {
    const user = this.repository.findById(id)
    return user ? toPublicUser(user) : null
  }
}
