export * from './users'
export * from './events'
export * from './planners'
export * from './attendees'
export * from './travel'
export * from './todos'
export * from './media'
export * from './chat'
export * from './datepoll'
export * from './ical'

// Relations
import { relations } from 'drizzle-orm'
import { user, session, account } from './users'
import { events } from './events'
import { planners } from './planners'
import { attendees } from './attendees'
import { travelGroups, travelGroupCommitments } from './travel'
import { organizerTodos, packListTemplateItems, attendeePackItems } from './todos'
import { media } from './media'
import { chatMessages } from './chat'
import { datePolls, datePollSlots, datePollResponses } from './datepoll'
import { icalTokens } from './ical'

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  planners: many(planners),
  attendees: many(attendees),
  assignedTodos: many(organizerTodos)
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] })
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] })
}))

export const eventRelations = relations(events, ({ one, many }) => ({
  parent: one(events, { fields: [events.parentId], references: [events.id], relationName: 'episodes' }),
  episodes: many(events, { relationName: 'episodes' }),
  planners: many(planners),
  attendees: many(attendees),
  travelGroups: many(travelGroups),
  organizerTodos: many(organizerTodos),
  packListTemplateItems: many(packListTemplateItems),
  media: many(media),
  chatMessages: many(chatMessages),
  datePoll: one(datePolls, { fields: [events.id], references: [datePolls.eventId] })
}))

export const plannerRelations = relations(planners, ({ one }) => ({
  event: one(events, { fields: [planners.eventId], references: [events.id] }),
  user: one(user, { fields: [planners.userId], references: [user.id] })
}))

export const attendeeRelations = relations(attendees, ({ one, many }) => ({
  event: one(events, { fields: [attendees.eventId], references: [events.id] }),
  user: one(user, { fields: [attendees.userId], references: [user.id] }),
  travelGroupCommitments: many(travelGroupCommitments),
  packItems: many(attendeePackItems),
  uploadedMedia: many(media, { relationName: 'uploadedByAttendee' }),
  assignedMedia: many(media, { relationName: 'assignedToAttendee' }),
  datePollResponses: many(datePollResponses),
  chatMessages: many(chatMessages),
  icalToken: one(icalTokens, { fields: [attendees.id], references: [icalTokens.attendeeId] })
}))

export const travelGroupRelations = relations(travelGroups, ({ one, many }) => ({
  event: one(events, { fields: [travelGroups.eventId], references: [events.id] }),
  commitments: many(travelGroupCommitments)
}))

export const travelGroupCommitmentRelations = relations(travelGroupCommitments, ({ one }) => ({
  travelGroup: one(travelGroups, { fields: [travelGroupCommitments.travelGroupId], references: [travelGroups.id] }),
  attendee: one(attendees, { fields: [travelGroupCommitments.attendeeId], references: [attendees.id] })
}))

export const organizerTodoRelations = relations(organizerTodos, ({ one }) => ({
  event: one(events, { fields: [organizerTodos.eventId], references: [events.id] }),
  assignedTo: one(user, { fields: [organizerTodos.assignedToId], references: [user.id] })
}))

export const packListTemplateItemRelations = relations(packListTemplateItems, ({ one, many }) => ({
  event: one(events, { fields: [packListTemplateItems.eventId], references: [events.id] }),
  attendeePackItems: many(attendeePackItems)
}))

export const attendeePackItemRelations = relations(attendeePackItems, ({ one }) => ({
  attendee: one(attendees, { fields: [attendeePackItems.attendeeId], references: [attendees.id] }),
  templateItem: one(packListTemplateItems, { fields: [attendeePackItems.templateItemId], references: [packListTemplateItems.id] })
}))

export const mediaRelations = relations(media, ({ one }) => ({
  event: one(events, { fields: [media.eventId], references: [events.id] }),
  uploadedByAttendee: one(attendees, {
    fields: [media.uploadedByAttendeeId],
    references: [attendees.id],
    relationName: 'uploadedByAttendee'
  }),
  assignedToAttendee: one(attendees, {
    fields: [media.assignedToAttendeeId],
    references: [attendees.id],
    relationName: 'assignedToAttendee'
  })
}))

export const chatMessageRelations = relations(chatMessages, ({ one }) => ({
  event: one(events, { fields: [chatMessages.eventId], references: [events.id] }),
  author: one(attendees, { fields: [chatMessages.authorId], references: [attendees.id] }),
  replyTo: one(chatMessages, {
    fields: [chatMessages.replyToId],
    references: [chatMessages.id],
    relationName: 'replies'
  })
}))

export const datePollRelations = relations(datePolls, ({ one, many }) => ({
  event: one(events, { fields: [datePolls.eventId], references: [events.id] }),
  slots: many(datePollSlots),
  decidedSlot: one(datePollSlots, { fields: [datePolls.decidedSlotId], references: [datePollSlots.id] })
}))

export const datePollSlotRelations = relations(datePollSlots, ({ one, many }) => ({
  poll: one(datePolls, { fields: [datePollSlots.pollId], references: [datePolls.id] }),
  responses: many(datePollResponses)
}))

export const datePollResponseRelations = relations(datePollResponses, ({ one }) => ({
  slot: one(datePollSlots, { fields: [datePollResponses.slotId], references: [datePollSlots.id] }),
  attendee: one(attendees, { fields: [datePollResponses.attendeeId], references: [attendees.id] })
}))

export const icalTokenRelations = relations(icalTokens, ({ one }) => ({
  attendee: one(attendees, { fields: [icalTokens.attendeeId], references: [attendees.id] })
}))
