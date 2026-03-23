import { defineConfig } from 'prisma/config'
import { Pool } from 'pg'

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrate: {
    async adapter() {
      const { PrismaPg } = await import('@prisma/adapter-pg')
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
      })
      return new PrismaPg(pool)
    },
  },
})