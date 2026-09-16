import { describe, expect, it, vi } from 'vitest'

/**
 * WHAT `recordSettlement` ASKS THE WRITE PATH FOR (#28).
 *
 * `test/settlements.test.ts` proves the arithmetic of a transfer by building
 * its lines directly — which is exactly the class of bug it therefore cannot
 * see: hand `buildEntryLines` the payer and the recipient the wrong way round
 * and every one of those tests still passes, because they are the ones passing
 * them in. Swapping the two in `recordSettlement` reddened fifteen checks in
 * `scripts/api-smoke.sh` and ZERO unit tests, which needs a built server, a
 * real Postgres and two session cookies to notice. This file is that assertion
 * in 300 milliseconds.
 *
 * `addExpense` is mocked to hand back its own arguments, and NOTHING ELSE from
 * that module is: the point is the translation — who is the payer, who is the
 * share, which destination — and every figure behind it is `addExpense`'s own,
 * asserted where it lives.
 */
vi.mock('../server/domain/expenses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/domain/expenses')>()
  return { ...actual, addExpense: vi.fn(async (...args: unknown[]) => args) }
})

const { recordSettlement } = await import('../server/domain/settlements')

const ASKED = async (input: Parameters<typeof recordSettlement>[1]) =>
  await recordSettlement('evt_1', input, { userId: 'user_1' }) as unknown as [
    string,
    { title: string, paidByEmail: string, paidByName: string, splitMode: string, note: string | null, participants: Array<{ name: string, email: string }> },
    { userId: string },
    string
  ]

describe('a payment is written as an entry from the sender to the recipient', () => {
  it('makes the SENDER the payer and the RECIPIENT the only share', async () => {
    const [eventId, entry, by, destination] = await ASKED({
      fromName: 'Cleo',
      fromEmail: 'Cleo@E.com',
      toName: 'Ana',
      toEmail: 'ana@e.com',
      amountCents: 10000,
      note: 'Twint, Tuesday'
    })
    expect(eventId).toBe('evt_1')
    // The direction, which is the whole of it: the person who handed the money
    // over is credited, and the person who received it is debited. Reversed,
    // recording a payment DEEPENS the debt it was meant to clear.
    expect(entry.paidByEmail).toBe('cleo@e.com')
    expect(entry.paidByName).toBe('Cleo')
    expect(entry.participants).toEqual([{ name: 'Ana', email: 'ana@e.com' }])
    // One share, not two: a transfer is not split between the pair of them.
    expect(entry.participants).toHaveLength(1)
    expect(entry.note).toBe('Twint, Tuesday')
    expect(by).toEqual({ userId: 'user_1' })
    // NO CATEGORY LINE — the shape that keeps it out of the trip total.
    expect(destination).toBe('transfer')
    // …and `even` rather than `exact`, so a mistyped amount can still be
    // corrected through the ordinary expense PATCH: an `exact` row refuses a
    // new total until the amounts come with it.
    expect(entry.splitMode).toBe('even')
    expect(entry.title).toBe('Cleo → Ana')
  })

  it('records no note when nobody typed one', async () => {
    const [, entry] = await ASKED({
      fromName: 'Ben',
      fromEmail: 'ben@e.com',
      toName: 'Ana',
      toEmail: 'ana@e.com',
      amountCents: 4000
    })
    expect(entry.note).toBeNull()
  })
})
