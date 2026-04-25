import * as React from 'react'
import { Button, Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'
import { absoluteUrl, formatEventWhen } from './_format'

const h = React.createElement

export interface DatePollDecidedEmailProps {
  recipientName?: string | null
  eventTitle: string
  eventSlug: string
  startsAt: Date | string
  endsAt?: Date | string | null
  location?: string | null
  inviteToken?: string | null
}

const buttonStyle: React.CSSProperties = {
  backgroundColor: '#111827',
  color: '#ffffff',
  borderRadius: '6px',
  padding: '12px 20px',
  textDecoration: 'none',
  display: 'inline-block'
}

/**
 * Sent to every poll respondent (and any planner) once a slot has been
 * picked. Pairs with a `.ics` attachment so the date drops straight into
 * the recipient's calendar.
 */
export function DatePollDecidedEmail(props: DatePollDecidedEmailProps) {
  const when = formatEventWhen(props.startsAt, props.endsAt ?? null)
  const url = props.inviteToken
    ? absoluteUrl(`/invite/${props.inviteToken}`)
    : absoluteUrl(`/events/${props.eventSlug}`)

  const children: React.ReactNode[] = [
    h(Heading, { key: 'h', as: 'h1' }, `It's official — ${props.eventTitle}`)
  ]
  if (props.recipientName) children.push(h(Text, { key: 'g' }, `Hi ${props.recipientName},`))
  children.push(h(Text, { key: 'i' }, `Thanks for voting. We've picked a date for ${props.eventTitle}.`))
  if (when) children.push(h(Text, { key: 'w' }, h('strong', null, 'When: '), when))
  if (props.location) children.push(h(Text, { key: 'l' }, h('strong', null, 'Where: '), props.location))
  children.push(
    h(Text, { key: 'cal' }, 'A calendar invite is attached — open it once and the event will land in your calendar.')
  )
  children.push(
    h(
      Text,
      { key: 'b' },
      h(Button, { href: url, style: buttonStyle }, 'See event details')
    )
  )

  return h(
    EmailLayout,
    { preview: `${props.eventTitle} — date confirmed` },
    ...children
  )
}

export default DatePollDecidedEmail
