import { describe, expect, it } from 'vitest'
import { eventToIcsAttributes, renderEventIcs, renderFeedIcs, type IcsEventInput } from '../server/utils/ics'

const base: IcsEventInput = {
  id: 'evt_1',
  slug: 'hike',
  title: 'Saturday hike',
  description: 'Bring water',
  startsAt: new Date('2026-07-01T08:00:00Z'),
  endsAt: new Date('2026-07-01T12:00:00Z'),
  location: 'Uetliberg',
  ticketUrl: null
}

describe('eventToIcsAttributes', () => {
  it('returns null for an event with no start time', () => {
    expect(eventToIcsAttributes({ ...base, startsAt: null })).toBeNull()
  })

  it('maps the row onto VEVENT attributes', () => {
    const attrs = eventToIcsAttributes(base)!
    expect(attrs.title).toBe('Saturday hike')
    expect(attrs.location).toBe('Uetliberg')
    expect(attrs.uid).toContain('evt_1')
    expect(attrs.start).toEqual([2026, 7, 1, 8, 0])
  })
})

describe('renderEventIcs', () => {
  it('renders a valid single VEVENT document', () => {
    const out = renderEventIcs(base)
    expect(out).toContain('BEGIN:VCALENDAR')
    expect(out).toContain('SUMMARY:Saturday hike')
    expect(out).toContain('END:VCALENDAR')
  })

  it('throws when the event has no start time', () => {
    expect(() => renderEventIcs({ ...base, startsAt: null })).toThrow()
  })
})

describe('renderFeedIcs', () => {
  it('renders multiple events and skips those without a start', () => {
    const out = renderFeedIcs([base, { ...base, id: 'evt_2', slug: 'dinner', title: 'Dinner', startsAt: null }])
    expect(out).toContain('SUMMARY:Saturday hike')
    expect(out).not.toContain('SUMMARY:Dinner')
  })
})
