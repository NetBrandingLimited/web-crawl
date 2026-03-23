import { defineConfig } from 'prisma/config'
import { Pool } from 'pg'

export default defineConfig({
  
  schema: './prisma/schema.prisma',
  migrate: {
    async adapter() {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
      })
      const { PrismaPg } = await import('@prisma/adapter-pg')
      return new PrismaPg(pool)
    },
  },
})