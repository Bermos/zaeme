import { integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { attendees } from './attendees'
import { events } from './events'

export const mediaTypeEnum = pgEnum('media_type', ['photo', 'video', 'document', 'ticket'])

export const media = pgTable('media', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  uploadedByAttendeeId: text('uploaded_by_attendee_id').references(() => attendees.id, { onDelete: 'set null' }),
  type: mediaTypeEnum('type').notNull(),
  r2Key: text('r2_key').notNull(),       // Cloudflare R2 object key
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  caption: text('caption'),
  assignedToAttendeeId: text('assigned_to_attendee_id').references(() => attendees.id, { onDelete: 'set null' }),
  takenAt: timestamp('taken_at', { withTimezone: true }), // extracted from EXIF when available
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
