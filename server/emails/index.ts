import * as React from 'react'
import { renderEmail } from './render'
import { InviteEmail, type InviteEmailProps } from './templates/invite'
import { RsvpConfirmationEmail, type RsvpConfirmationEmailProps } from './templates/rsvp-confirmation'
import { EventReminderEmail, type EventReminderEmailProps } from './templates/event-reminder'
import { EventCancelledEmail, type EventCancelledEmailProps } from './templates/event-cancelled'
import { MagicLinkEmail, type MagicLinkEmailProps } from './templates/magic-link'

/**
 * zäme's outgoing mail — Resend delivery plus the react-email templates.
 * React is contained entirely in this directory: callers get
 * `render*Email(props) => { html, text }` and `sendEmail`, so no handler or
 * background job ever imports React or JSX.
 */

export { sendEmail, type SendEmailOptions, type SendEmailResult } from './send'
export { renderEmail } from './render'
export { absoluteUrl, formatEventWhen, publicSiteUrl, resolveBaseUrl, resolvePublicSiteUrl } from './format'

export type {
  InviteEmailProps,
  RsvpConfirmationEmailProps,
  EventReminderEmailProps,
  EventCancelledEmailProps,
  MagicLinkEmailProps
}

type Rendered = Promise<{ html: string, text: string }>

export function renderInviteEmail(props: InviteEmailProps): Rendered {
  return renderEmail(React.createElement(InviteEmail, props))
}

export function renderRsvpConfirmationEmail(props: RsvpConfirmationEmailProps): Rendered {
  return renderEmail(React.createElement(RsvpConfirmationEmail, props))
}

export function renderEventReminderEmail(props: EventReminderEmailProps): Rendered {
  return renderEmail(React.createElement(EventReminderEmail, props))
}

export function renderEventCancelledEmail(props: EventCancelledEmailProps): Rendered {
  return renderEmail(React.createElement(EventCancelledEmail, props))
}

export function renderMagicLinkEmail(props: MagicLinkEmailProps): Rendered {
  return renderEmail(React.createElement(MagicLinkEmail, props))
}
