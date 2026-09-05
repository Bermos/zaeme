import * as React from 'react'
import { Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'
import { absoluteUrl, formatEventWhen, publicSiteUrl } from '../format'

const h = React.createElement

export interface EventReminderEmailProps {
  recipientName?: string | null
  eventTitle: string
  eventSlug: string
  startsAt: Date | string
  endsAt?: Date | string | null
  location?: string | null
  inviteToken?: string | null
}

export function EventReminderEmail(props: EventReminderEmailProps) {
  const when = formatEventWhen(props.startsAt, props.endsAt ?? null)
  // Guests land on their zäme invite page; the tokenless fallback stays the
  // owner app's events dive-in (only planners receive those).
  const url = props.inviteToken
    ? publicSiteUrl(`/i/${props.inviteToken}`)
    : absoluteUrl(`/events/${props.eventSlug}`)

  const children: React.ReactNode[] = [
    h(Heading, { key: 'h', as: 'h1' }, `Two days to go — ${props.eventTitle}`)
  ]
  if (props.recipientName) children.push(h(Text, { key: 'g' }, `Hi ${props.recipientName},`))
  children.push(h(Text, { key: 'b' }, `Just a quick heads up — ${props.eventTitle} is coming up.`))
  if (when) children.push(h(Text, { key: 'w' }, h('strong', null, 'When: '), when))
  if (props.location) children.push(h(Text, { key: 'l' }, h('strong', null, 'Where: '), props.location))
  children.push(
    h(
      Text,
      { key: 'link' },
      'See the full details and check who else is coming: ',
      h('a', { href: url }, url)
    )
  )

  return h(
    EmailLayout,
    { preview: `${props.eventTitle} is in 48 hours` },
    ...children
  )
}

export default EventReminderEmail
