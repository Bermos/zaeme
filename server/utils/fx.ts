/**
 * Foreign-exchange rates, from frankfurter.app (#25, D4).
 *
 * frankfurter.app republishes the ECB's daily reference rates: no key, no
 * account, no rate limit worth the name. It is the only outbound dependency the
 * budget has, and it is deliberately a WEAK one:
 *
 *  - every call is bounded by a short timeout and swallows every failure into
 *    `null`, because recording an expense must never hang on somebody else's
 *    HTTP server;
 *  - the rate it returns is a SNAPSHOT the caller freezes onto the expense, not
 *    a lookup anything repeats later. History must not move when the market
 *    does;
 *  - a `null` is an ordinary answer, not an error: the form then asks for the
 *    rate by hand, which is also the whole story on an instance with no
 *    outbound network at all.
 *
 * The rate is carried as a decimal STRING end to end. It is multiplied by
 * money, and the one thing this codebase does not do with money is floats.
 */

/** Where the rates come from. One place, so a smoke run can see it. */
const FRANKFURTER = 'https://api.frankfurter.app'

/** How long an expense write is prepared to wait for a rate. */
const TIMEOUT_MS = 2500

export interface FxQuote {
  from: string
  to: string
  /** Decimal string: `amount_in_from × rate = amount_in_to`. */
  rate: string
  /** The ECB publication date the rate came from (`YYYY-MM-DD`). */
  asOf: string
  source: 'frankfurter'
}

/** Three ASCII letters, upper-cased. Anything else is not a currency here. */
export function normaliseCurrency(code: string): string {
  return code.trim().toUpperCase()
}

export function isCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(normaliseCurrency(code))
}

/**
 * The live rate from `from` into `to`, or `null` if it cannot be had — a
 * network failure, a timeout, a currency the ECB does not publish, a malformed
 * answer. Never throws.
 *
 * An identity conversion answers 1 without leaving the process.
 */
export async function fetchFxRate(from: string, to: string): Promise<FxQuote | null> {
  const base = normaliseCurrency(from)
  const target = normaliseCurrency(to)
  if (!isCurrencyCode(base) || !isCurrencyCode(target)) return null
  if (base === target) {
    return { from: base, to: target, rate: '1', asOf: new Date().toISOString().slice(0, 10), source: 'frankfurter' }
  }

  try {
    const res = await $fetch<{ date?: string, rates?: Record<string, number> }>(`${FRANKFURTER}/latest`, {
      query: { base, symbols: target },
      timeout: TIMEOUT_MS,
      retry: 0
    })
    const rate = res?.rates?.[target]
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
    return {
      from: base,
      to: target,
      // `toString()` on the parsed number, not a fixed-point rounding: ECB
      // rates have four to six significant decimals and the column holds ten.
      rate: String(rate),
      asOf: typeof res.date === 'string' ? res.date : new Date().toISOString().slice(0, 10),
      source: 'frankfurter'
    }
  } catch {
    // Deliberately silent. The caller's fallback is to ask a human.
    return null
  }
}
