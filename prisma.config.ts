import { defineConfig } from 'prisma/config'
import { Pool } from 'pg'

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrate: {
    async adapter() {
      const { PrismaPg } = await import('@prisma/adapter-pg')
      const pool = new Pool({
        connectionString: process.env.postgresql://postgres:waECbW190kjK8kX3@db.rzevyaunijdxsiflncpd.supabase.co:5432/postgres,
      })
      return new PrismaPg(pool)
    },
  },
})