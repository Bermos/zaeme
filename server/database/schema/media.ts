import { relations } from 'drizzle-orm'
import { bigint, index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth'
import { event } from './events'
import { rsvp } from './rsvp'

export const mediaTypeEnum = pgEnum('media_type', ['photo', 'video', 'document', 'ticket'])
export const mediaStatusEnum = pgEnum('media_status', ['pending', 'ready'])

/**
 * A single item of event media (photo, video, document, or ticket).
 *
 * Uploads follow a two-step flow:
 *   1. Presign — the server records a `pending` row and returns a presigned
 *      R2 PUT URL. The browser uploads bytes directly to R2.
 *   2. Confirm — the browser calls back with the metadata (size, mime, name,
 *      takenAt) once the PUT succeeds, and the row is flipped to `ready`.
 *
 * `pending` rows without a matching confirm are cleaned up lazily — treat
 * them as expired after the presign URL's 15-minute TTL.
 *
 * Uploader identity is either a registered user (`uploadedByUserId`) or a
 * guest via RSVP token (`uploadedByRsvpId`). Exactly one is set per row.
 *
 * `assignedRsvpId` is used for tickets — a planner uploads a ticket file
 * and assigns it to a specific attendee's RSVP.
 */
export const media = pgTable(
  'media',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    type: mediaTypeEnum('type').notNull(),
    status: mediaStatusEnum('status').notNull().default('pending'),
    // Object storage location
    storageKey: text('storage_key').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    fileName: text('file_name').notNull(),
    // User-editable
    caption: text('caption'),
    // Sort key for the timeline view — defaults to createdAt when absent
    takenAt: timestamp('taken_at', { withTimezone: true }),
    // Uploader identity (exactly one of these is set)
    uploadedByUserId: text('uploaded_by_user_id')
      .references(() => user.id, { onDelete: 'set null' }),
    uploadedByRsvpId: text('uploaded_by_rsvp_id')
      .references(() => rsvp.id, { onDelete: 'set null' }),
    // Tickets only — which attendee this ticket belongs to
    assignedRsvpId: text('assigned_rsvp_id')
      .references(() => rsvp.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('media_eventId_idx').on(table.eventId),
    index('media_type_idx').on(table.type),
    index('media_status_idx').on(table.status),
    index('media_takenAt_idx').on(table.takenAt),
    index('media_assignedRsvpId_idx').on(table.assignedRsvpId)
  ]
)

export const mediaRelations = relations(media, ({ one }) => ({
  event: one(event, {
    fields: [media.eventId],
    references: [event.id]
  }),
  uploadedByUser: one(user, {
    fields: [media.uploadedByUserId],
    references: [user.id]
  }),
  uploadedByRsvp: one(rsvp, {
    fields: [media.uploadedByRsvpId],
    references: [rsvp.id],
    relationName: 'mediaUploadedByRsvp'
  }),
  assignedRsvp: one(rsvp, {
    fields: [media.assignedRsvpId],
    references: [rsvp.id],
    relationName: 'mediaAssignedRsvp'
  })
}))
