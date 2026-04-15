/**
 * Seed script for development data.
 * Run with: pnpm db:seed
 */
import * as dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getDb } from './client.js'
import {
  users,
  events,
  eventPlanners,
  attendees,
} from './schema/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env') })

async function seed() {
  const db = getDb()

  console.log('🌱 Seeding development data...')

  // Create admin user
  const [admin] = await db
    .insert(users)
    .values({
      email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      emailVerified: true,
    })
    .onConflictDoNothing()
    .returning()

  if (!admin) {
    console.log('Admin user already exists, skipping seed.')
    process.exit(0)
  }

  console.log(`✅ Created admin: ${admin.email}`)

  // Create a sample event
  const [event] = await db
    .insert(events)
    .values({
      slug: 'test-birthday-party',
      title: 'Test Birthday Party',
      description: 'A sample event for development.',
      type: 'hosted',
      status: 'published',
      venue: 'Volkshaus Bern',
      venueAddress: 'Neubrückstrasse 8, 3012 Bern',
      startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1 week from now
      endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000),
    })
    .returning()

  console.log(`✅ Created event: ${event.title}`)

  // Add admin as owner
  await db.insert(eventPlanners).values({
    eventId: event.id,
    userId: admin.id,
    role: 'owner',
  })

  // Add a sample attendee
  await db.insert(attendees).values({
    eventId: event.id,
    guestName: 'Alice',
    guestEmail: 'alice@example.com',
    rsvpStatus: 'yes',
  })

  await db.insert(attendees).values({
    eventId: event.id,
    guestName: 'Bob',
    guestEmail: 'bob@example.com',
    rsvpStatus: 'maybe',
  })

  console.log('✅ Created sample attendees')
  console.log('🎉 Seed complete!')
  process.exit(0)
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
