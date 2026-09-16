import { createObjectStore, isStorageConfigured } from './storage'
import type { MediaItemView } from '../domain/index'

/**
 * zäme's half of the media seam: core hands back storage keys, this signs a
 * short-lived download URL per item with the app's object store. Signing is
 * local (SigV4) — no network round-trip per item.
 */

export type SignedMediaItem = MediaItemView & { url: string }

export function assertStorageConfigured(): void {
  if (!isStorageConfigured()) {
    throw createError({ statusCode: 501, message: 'Object storage is not configured on this instance' })
  }
}

/**
 * GENERIC IN THE ITEM, not in `MediaItemView`, and that is load-bearing rather
 * than tidy. The invite link's tickets carry two fields no other surface has —
 * `mine` and `assignedTo` (#37) — and a signature fixed to `MediaItemView[]`
 * would keep them at runtime (the spread copies everything) while ERASING them
 * from the type on the way out. The card would then read `t.mine` off a type
 * that does not have it, `nuxt typecheck` would refuse the binding, and the
 * obvious way out is a cast — which is the #78 shape this repository has
 * already shipped twice. The generic makes the wire shape and the type agree
 * without anybody asserting anything.
 */
export async function signMediaItems<T extends MediaItemView>(items: T[]): Promise<Array<T & { url: string }>> {
  if (items.length === 0) return []
  assertStorageConfigured()
  const store = createObjectStore()
  return Promise.all(items.map(async item => ({
    ...item,
    url: await store.presignDownload(item.storageKey)
  })))
}

/* --------------------------- the receipt pin (#29) -------------------------- */

/** What a budget looks like from here: expenses that may each carry a receipt. */
interface BudgetWithReceipts {
  expenses: Array<{ receipt: MediaItemView | null }>
}

/**
 * Sign the receipt on every expense in a budget, in ONE place, because thirteen
 * handlers answer with a budget and a thumbnail missing from one of them is a
 * bug nobody notices for a release. `test/api-boundary.test.ts` asserts that
 * every one of them calls this.
 *
 * `loadBudget` hands back a storage key (the domain has no object store); this
 * turns it into the same short-lived signed URL `signMediaItems` produces for
 * the gallery, and for the same reason: a media URL in this app is always
 * signed and always expires, never stored and never guessable.
 *
 * WHEN STORAGE IS NOT CONFIGURED it leaves the receipts alone rather than
 * throwing. An instance in that state cannot serve any media at all — the
 * gallery 501s, and nothing can have been uploaded to pin — so the only way to
 * be here is a bucket that went away underneath existing rows, and a budget
 * that 501s because of a thumbnail would take the whole money screen down with
 * it. The card renders the entry with no receipt; `url` is what it keys on.
 *
 * `/api/v1` calls none of this ON PURPOSE. No download URL crosses that
 * boundary (`server/api/v1/events/[slug]/media.get.ts` says so for the
 * gallery), and `v1-shapes.expense` drops the field entirely.
 */
export async function signBudgetReceipts<T extends BudgetWithReceipts>(budget: T): Promise<T> {
  const pinned = budget.expenses.filter(x => x.receipt)
  if (pinned.length === 0 || !isStorageConfigured()) return budget
  const store = createObjectStore()
  await Promise.all(pinned.map(async (x) => {
    x.receipt = { ...x.receipt!, url: await store.presignDownload(x.receipt!.storageKey) } as SignedMediaItem
  }))
  return budget
}
