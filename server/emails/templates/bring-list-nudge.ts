import * as React from 'react'
import { Heading, Text } from '@react-email/components'
import { EmailLayout } from './_layout'
import { absoluteUrl, formatEventWhen, publicSiteUrl } from '../format'

const h = React.createElement

/**
 * THE NIGHT BEFORE, WHAT IS STILL MISSING (#46).
 *
 * `gaps` is the whole message and it is ALREADY THE SHORT LIST: this template
 * renders what it is handed and never reaches for the bring list itself, so
 * the decision about which items are named lives in `gapLine`
 * (`server/domain/contributions.ts`), where a unit test executes it. Nothing in
 * this repository renders an email in CI beyond `test/bring-list-nudge.test.ts`
 * — which is why the selection is not made here.
 */
export interface BringListNudgeEmailProps {
  recipientName?: string | null
  eventTitle: string
  eventSlug: string
  startsAt?: Date | string | null
  endsAt?: Date | string | null
  /** The event's display zone (#31); null renders in the server's own clock. */
  timezone?: string | null
  location?: string | null
  /** One line per still-missing item. Never empty — the job does not send otherwise. */
  gaps: readonly string[]
  inviteToken?: string | null
}

export function BringListNudgeEmail(props: BringListNudgeEmailProps) {
  const when = formatEventWhen(props.startsAt ?? null, props.endsAt ?? null, props.timezone ?? null)
  // Guests land on their own invite page, where the list can be claimed; the
  // tokenless fallback is the owner app, which only planners can open.
  const url = props.inviteToken
    ? publicSiteUrl(`/i/${props.inviteToken}`)
    : absoluteUrl(`/events/${props.eventSlug}`)

  const children: React.ReactNode[] = [
    h(Heading, { key: 'h', as: 'h1' }, `Still to bring — ${props.eventTitle}`)
  ]
  if (props.recipientName) children.push(h(Text, { key: 'g' }, `Hi ${props.recipientName},`))
  children.push(h(
    Text,
    { key: 'b' },
    props.gaps.length === 1
      ? `One thing on the bring list for ${props.eventTitle} is still spoken for by nobody:`
      : `${props.gaps.length} things on the bring list for ${props.eventTitle} are still spoken for by nobody:`
  ))
  children.push(h(
    'ul',
    { key: 'gaps' },
    props.gaps.map((line, i) => h('li', { key: `gap-${i}` }, h(Text, null, line)))
  ))
  if (when) children.push(h(Text, { key: 'w' }, h('strong', null, 'When: '), when))
  if (props.location) children.push(h(Text, { key: 'l' }, h('strong', null, 'Where: '), props.location))
  children.push(h(
    Text,
    { key: 'link' },
    'Claim something (or see what everybody else is bringing): ',
    h('a', { href: url }, url)
  ))

  return h(
    EmailLayout,
    { preview: `${props.gaps.length} still to bring for ${props.eventTitle}` },
    ...children
  )
}

export default BringListNudgeEmail
