import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { events } from './events.js'
import { attendees } from './attendees.js'

export const mediaTypeEnum = pgEnum('media_type', [
  'photo',
  'video',
  'document',
  'ticket',
])

export const media = pgTable('media', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),

  // Uploader — can be guest or registered user
  uploaderAttendeeId: text('uploader_attendee_id').references(() => attendees.id, { onDelete: 'set null' }),

  type: mediaTypeEnum('type').notNull(),
  r2Key: text('r2_key').notNull(),
  mimeType: text('mime_type').notNull(),
  filename: text('filename').notNull(),
  filesize: text('filesize'), // bytes as string to avoid bigint issues
  caption: text('caption'),

  // For tickets: the attendee this ticket is assigned to
  assignedAttendeeId: text('assigned_attendee_id').references(() => attendees.id, { onDelete: 'set null' }),

  // For photos: EXIF or user-provided datetime
  takenAt: timestamp('taken_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mediaRelations = relations(media, ({ one }) => ({
  event: one(events, { fields: [media.eventId], references: [events.id] }),
  uploaderAttendee: one(attendees, {
    fields: [media.uploaderAttendeeId],
    references: [attendees.id],
    relationName: 'uploadedMedia',
  }),
  assignedAttendee: one(attendees, {
    fields: [media.assignedAttendeeId],
    references: [attendees.id],
    relationName: 'assignedTickets',
  }),
}))

export type Media = typeof media.$inferSelect
export type NewMedia = typeof media.$inferInsert
