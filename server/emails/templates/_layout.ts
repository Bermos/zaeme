import * as React from 'react'
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text
} from '@react-email/components'

/**
 * Shared layout used by every transactional email. Keeps branding and footer
 * copy in one place. Lifted from zaeme `server/emails/_layout.ts`.
 *
 * These templates are written with `React.createElement` (aliased as `h`) rather
 * than JSX because the consuming Nuxt typecheck runs `vue-tsc`, which assumes Vue
 * JSX semantics for `.tsx` files. Plain TS keeps the types correct everywhere.
 */

const h = React.createElement

export interface EmailLayoutProps {
  preview: string
  /** Optional — accepted via `React.createElement` rest args. */
  children?: React.ReactNode
  /** Public base URL (used in the footer). */
  baseUrl?: string
}

const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '24px',
  maxWidth: '560px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  color: '#111827'
}

const body: React.CSSProperties = {
  backgroundColor: '#f9fafb',
  margin: 0,
  padding: 0
}

const footerStyle: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '12px',
  lineHeight: '18px',
  marginTop: '24px'
}

const brand: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '18px',
  margin: '0 0 16px'
}

export function EmailLayout({ preview, children, baseUrl }: EmailLayoutProps) {
  const url = baseUrl || process.env.BASE_URL || process.env.BETTER_AUTH_URL || ''
  const footerCopy: React.ReactNode[] = [
    'You received this email because someone invited you to an event on zäme'
  ]
  if (url) {
    footerCopy.push(
      ' — ',
      h(Link, { key: 'url', href: url }, url.replace(/^https?:\/\//, ''))
    )
  }
  footerCopy.push(
    '. If this looks like a mistake, simply ignore this message or reply to let the sender know.'
  )

  return h(
    Html,
    null,
    h(Head, null),
    h(Preview, null, preview),
    h(
      Body,
      { style: body },
      h(
        Container,
        { style: container },
        h(Text, { style: brand }, 'zäme'),
        h(Section, null, children),
        h(Hr, null),
        h(Text, { style: footerStyle }, ...footerCopy)
      )
    )
  )
}
