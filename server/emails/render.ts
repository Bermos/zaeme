import type * as React from 'react'
import { render } from '@react-email/render'

/**
 * Render a React Email template to `{ html, text }`. Kept as a thin helper
 * so Inngest functions and other callers do not need to import React
 * directly.
 */
export async function renderEmail(node: React.ReactElement): Promise<{ html: string, text: string }> {
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true })
  ])
  return { html, text }
}
