import * as React from 'react'
import { Button, Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'
import { absoluteUrl, formatEventWhen } from './_format'

const h = React.createElement

export interface DatePollInviteEmailProps {
  recipientName?: string | null
  hostName?: string | null
  eventTitle: string
  /** Optional planner-supplied prompt — e.g. "Which weekend works for you?". */
  question?: string | null
  /** Up to ~5 candidate slots are listed inline; rest are hidden behind the button. */
  slots: { startsAt: Date | string, endsAt?: Date | string | null }[]
  deadline?: Date | string | null
  inviteToken: string
}

const buttonStyle: React.CSSProperties = {
  backgroundColor: '#111827',
  color: '#ffffff',
  borderRadius: '6px',
  padding: '12px 20px',
  textDecoration: 'none',
  display: 'inline-block'
}

export function DatePollInviteEmail(props: DatePollInviteEmailProps) {
  const inviteUrl = absoluteUrl(`/invite/${props.inviteToken}`)
  const greeting = props.recipientName ? `Hi ${props.recipientName},` : 'Hi there,'
  const intro = props.hostName
    ? `${props.hostName} is planning ${props.eventTitle} and wants to find a date that works for everyone.`
    : `${props.eventTitle} is being planned and we're looking for a date that works for everyone.`

  const previewSlots = props.slots.slice(0, 5)
  const slotItems = previewSlots
    .map((s, i) => h('li', { key: `s${i}` }, formatEventWhen(s.startsAt, s.endsAt ?? null) ?? ''))
    .filter(Boolean)

  const deadlineLine = props.deadline
    ? formatEventWhen(props.deadline, null)
    : null

  const children: React.ReactNode[] = [
    h(Heading, { key: 'h', as: 'h1' }, `Pick a date — ${props.eventTitle}`),
    h(Text, { key: 'g' }, greeting),
    h(Text, { key: 'i' }, intro),
    props.question ? h(Text, { key: 'q' }, h('strong', null, props.question)) : null,
    slotItems.length > 0
      ? h(
          'ul',
          { key: 'sl', style: { paddingLeft: '20px', margin: '12px 0' } },
          ...slotItems
        )
      : null,
    props.slots.length > previewSlots.length
      ? h(
          Text,
          { key: 'more', style: { color: '#6b7280', fontSize: '13px' } },
          `…and ${props.slots.length - previewSlots.length} more option${props.slots.length - previewSlots.length === 1 ? '' : 's'}.`
        )
      : null,
    deadlineLine
      ? h(Text, { key: 'd' }, h('strong', null, 'Please respond by: '), deadlineLine)
      : null,
    h(
      Text,
      { key: 'b' },
      h(Button, { href: inviteUrl, style: buttonStyle }, 'Vote on a date')
    ),
    h(
      Text,
      { key: 'fb', style: { fontSize: '12px', color: '#6b7280' } },
      'Or open this link: ',
      inviteUrl
    )
  ].filter(Boolean)

  return h(
    EmailLayout,
    { preview: `Help pick a date for ${props.eventTitle}` },
    ...children
  )
}

export default DatePollInviteEmail
