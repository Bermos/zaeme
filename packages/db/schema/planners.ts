import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { users } from './users.js'
import { events } from './events.js'

export const plannerRoleEnum = pgEnum('planner_role', [
  'owner',
  'co_planner',
  'logistics',
])

export const eventPlanners = pgTable('event_planners', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: plannerRoleEnum('role').notNull().default('co_planner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const eventPlannersRelations = relations(eventPlanners, ({ one }) => ({
  event: one(events, { fields: [eventPlanners.eventId], references: [events.id] }),
  user: one(users, { fields: [eventPlanners.userId], references: [users.id] }),
}))

export type EventPlanner = typeof eventPlanners.$inferSelect
export type NewEventPlanner = typeof eventPlanners.$inferInsert
