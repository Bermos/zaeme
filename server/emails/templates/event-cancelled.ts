import * as React from 'react'
import { Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'
import { formatEventWhen } from '../format'

const h = React.createElement

export interface EventCancelledEmailProps {
  recipientName?: string | null
  eventTitle: string
  startsAt?: Date | string | null
  endsAt?: Date | string | null
  location?: string | null
  /** Optional free-form reason provided by the planner. */
  reason?: string | null
}

export function EventCancelledEmail(props: EventCancelledEmailProps) {
  const when = formatEventWhen(props.startsAt ?? null, props.endsAt ?? null)
  const children: React.ReactNode[] = [
    h(Heading, { key: 'h', as: 'h1' }, `${props.eventTitle} — cancelled`)
  ]
  if (props.recipientName) children.push(h(Text, { key: 'g' }, `Hi ${props.recipientName},`))
  children.push(
    h(
      Text,
      { key: 'b' },
      'We\'re sorry — ',
      h('strong', null, props.eventTitle),
      ' has been cancelled.'
    )
  )
  if (when) children.push(h(Text, { key: 'w' }, `Originally scheduled for ${when}.`))
  if (props.location) children.push(h(Text, { key: 'l' }, `Location: ${props.location}.`))
  if (props.reason) children.push(h(Text, { key: 'r' }, props.reason))
  children.push(
    h(
      Text,
      { key: 'cal' },
      'Your calendar entry will be removed next time it syncs. Hopefully we can catch up another time.'
    )
  )

  return h(
    EmailLayout,
    { preview: `${props.eventTitle} has been cancelled` },
    ...children
  )
}

export default EventCancelledEmail
