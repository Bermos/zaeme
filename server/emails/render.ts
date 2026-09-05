import type * as React from 'react'
import { render } from '@react-email/render'

/**
 * Render a React Email template to `{ html, text }`. Kept as a thin helper so
 * callers (department triggers, auth) do not need to import React directly.
 * Lifted from zaeme `server/emails/render.ts`.
 */
export async function renderEmail(node: React.ReactElement): Promise<{ html: string, text: string }> {
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true })
  ])
  return { html, text }
}
