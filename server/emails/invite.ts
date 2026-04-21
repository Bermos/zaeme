import * as React from 'react'
import { Button, Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'
import { absoluteUrl, formatEventWhen } from './_format'

const h = React.createElement

export interface InviteEmailProps {
  recipientName?: string | null
  hostName?: string | null
  eventTitle: string
  eventType: 'hosted' | 'concert' | 'series'
  eventDescription?: string | null
  startsAt?: Date | string | null
  endsAt?: Date | string | null
  location?: string | null
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

export function InviteEmail(props: InviteEmailProps) {
  const when = formatEventWhen(props.startsAt ?? null, props.endsAt ?? null)
  const inviteUrl = absoluteUrl(`/invite/${props.inviteToken}`)
  const greeting = props.recipientName ? `Hi ${props.recipientName},` : 'Hi there,'
  const hostLine = props.hostName
    ? `${props.hostName} invited you to ${props.eventTitle}.`
    : `You're invited to ${props.eventTitle}.`

  const children = [
    h(Heading, { key: 'h', as: 'h1' }, props.eventTitle),
    h(Text, { key: 'g' }, greeting),
    h(Text, { key: 'hl' }, hostLine),
    when ? h(Text, { key: 'w' }, h('strong', null, 'When: '), when) : null,
    props.location ? h(Text, { key: 'l' }, h('strong', null, 'Where: '), props.location) : null,
    props.eventDescription ? h(Text, { key: 'd' }, props.eventDescription) : null,
    h(
      Text,
      { key: 'b' },
      h(
        Button,
        { href: inviteUrl, style: buttonStyle },
        props.eventType === 'concert' ? 'I\'m there' : 'RSVP now'
      )
    ),
    h(
      Text,
      { key: 'fallback', style: { fontSize: '12px', color: '#6b7280' } },
      'Or open this link: ',
      inviteUrl
    )
  ]

  return h(
    EmailLayout,
    { preview: `You're invited to ${props.eventTitle}` },
    ...children.filter(Boolean)
  )
}

export default InviteEmail
