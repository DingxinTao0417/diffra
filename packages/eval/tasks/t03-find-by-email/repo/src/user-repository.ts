export interface User {
  id: string
  email: string
  name: string
  passwordHash: string
}

export class UserRepository {
  private readonly users = new Map<string, User>()

  save(user: User): void {
    this.users.set(user.id, user)
  }

  findById(id: string): User | null {
    return this.users.get(id) ?? null
  }
}
