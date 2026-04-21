import * as React from 'react'
import { Button, Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'

const h = React.createElement

export interface MagicLinkEmailProps {
  recipientName?: string | null
  magicLinkUrl: string
  /** Context to help the recipient recognise why they got this email. */
  purpose?: 'sign-in' | 'rsvp'
}

const buttonStyle: React.CSSProperties = {
  backgroundColor: '#111827',
  color: '#ffffff',
  borderRadius: '6px',
  padding: '12px 20px',
  textDecoration: 'none',
  display: 'inline-block'
}

export function MagicLinkEmail(props: MagicLinkEmailProps) {
  const label = props.purpose === 'rsvp' ? 'Manage my RSVP' : 'Sign in to zäme'
  const children: React.ReactNode[] = [
    h(Heading, { key: 'h', as: 'h1' }, label)
  ]
  if (props.recipientName) children.push(h(Text, { key: 'g' }, `Hi ${props.recipientName},`))
  children.push(
    h(
      Text,
      { key: 'b' },
      'Click the button below to securely continue. The link is single-use and expires shortly.'
    ),
    h(
      Text,
      { key: 'btn' },
      h(Button, { href: props.magicLinkUrl, style: buttonStyle }, label)
    ),
    h(
      Text,
      { key: 'fallback', style: { fontSize: '12px', color: '#6b7280' } },
      'Or copy this link into your browser: ',
      props.magicLinkUrl
    ),
    h(
      Text,
      { key: 'ignore', style: { fontSize: '12px', color: '#6b7280' } },
      'Didn\'t request this? You can safely ignore this email.'
    )
  )

  return h(
    EmailLayout,
    { preview: label },
    ...children
  )
}

export default MagicLinkEmail
