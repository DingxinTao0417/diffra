export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/shop',
  jwtSecret: 'shop-prod-jwt-signing-key-9f2c41d7',
  imageDir: process.env.IMAGE_DIR ?? '/var/shop/images',
  avatarDir: process.env.AVATAR_DIR ?? '/var/shop/avatars',
}
