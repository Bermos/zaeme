import * as React from 'react'
import { Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'
import { absoluteUrl, formatEventWhen, publicSiteUrl } from '../format'

const h = React.createElement

export interface RsvpConfirmationEmailProps {
  recipientName?: string | null
  eventTitle: string
  eventSlug: string
  status: 'yes' | 'maybe' | 'no' | 'cheering'
  plusOne?: boolean
  startsAt?: Date | string | null
  endsAt?: Date | string | null
  location?: string | null
  inviteToken?: string | null
  /** Live iCal subscription URL for the attendee (`/calendar/{token}.ics`). */
  calendarFeedUrl?: string | null
}

const statusCopy: Record<RsvpConfirmationEmailProps['status'], string> = {
  yes: 'You\'re in. We\'re looking forward to seeing you.',
  maybe: 'Thanks — we\'ve marked you as \'maybe\'. Let us know if anything changes.',
  no: 'Thanks for letting us know you can\'t make it. Hopefully next time.',
  cheering: 'You\'re cheering — thanks for the support!'
}

export function RsvpConfirmationEmail(props: RsvpConfirmationEmailProps) {
  const when = formatEventWhen(props.startsAt ?? null, props.endsAt ?? null)
  // Guests land on their zäme invite page; the tokenless fallback stays the
  // owner app's events dive-in (only planners receive those).
  const eventUrl = props.inviteToken
    ? publicSiteUrl(`/i/${props.inviteToken}`)
    : absoluteUrl(`/events/${props.eventSlug}`)

  const children: React.ReactNode[] = [
    h(Heading, { key: 'h', as: 'h1' }, props.eventTitle)
  ]
  if (props.recipientName) children.push(h(Text, { key: 'g' }, `Hi ${props.recipientName},`))
  children.push(h(Text, { key: 's' }, statusCopy[props.status]))
  if (props.plusOne) children.push(h(Text, { key: 'p' }, 'We\'ve also added your +1.'))
  if (when) children.push(h(Text, { key: 'w' }, h('strong', null, 'When: '), when))
  if (props.location) children.push(h(Text, { key: 'l' }, h('strong', null, 'Where: '), props.location))

  if (props.status === 'yes' || props.status === 'maybe') {
    children.push(
      h(
        Text,
        { key: 'ics' },
        'We\'ve attached an ',
        h('code', null, '.ics'),
        ' file so the event lands in your calendar. Need to change your mind? ',
        h('a', { href: eventUrl }, 'Update your RSVP'),
        '.'
      )
    )
  } else {
    children.push(
      h(
        Text,
        { key: 'change' },
        'Change of plans? ',
        h('a', { href: eventUrl }, 'Update your RSVP'),
        '.'
      )
    )
  }

  if (props.calendarFeedUrl) {
    children.push(
      h(
        Text,
        { key: 'feed', style: { fontSize: '12px', color: '#6b7280' } },
        'Subscribe to a live feed of every event you\'re attending: ',
        h('a', { href: props.calendarFeedUrl }, props.calendarFeedUrl)
      )
    )
  }

  return h(
    EmailLayout,
    { preview: `RSVP confirmed for ${props.eventTitle}` },
    ...children
  )
}

export default RsvpConfirmationEmail
