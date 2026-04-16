import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { events } from './events'
import { user } from './users'

export const plannerRoleEnum = pgEnum('planner_role', ['owner', 'co_planner', 'logistics'])

export const planners = pgTable('planners', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: plannerRoleEnum('role').notNull().default('co_planner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
