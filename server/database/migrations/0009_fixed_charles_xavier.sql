-- Currency belongs to the trip (#59).
--
-- THE FIRST MIGRATION IN THIS REPO WHOSE ENTIRE CONTENT IS A BACKFILL. Both new
-- columns are NOT NULL and neither has a constant that is true of every row, so
-- the generated form —
--
--     ALTER TABLE events_event   ADD COLUMN currency       text NOT NULL;
--     ALTER TABLE events_expense ADD COLUMN fx_rate_source text NOT NULL;
--
-- - aborts the instant either table holds a row, which as the Kitchen `migrate`
-- task means a deploy stranded on the previous release and a change that simply
-- is not there. What is written below has the SAME final shape (so the drizzle
-- snapshot still matches and `pnpm db:generate` reports no drift) and survives a
-- full database: add nullable, fill, then tighten.
--
-- WHERE EACH VALUE COMES FROM, and why it is not the obvious constant:
--
--   events_event.currency - for an event that HOLDS EXPENSES, the base currency
--     those expenses were already converted into. Nothing else is safe: an
--     expense froze `amount_base_cents` against that currency, so labelling the
--     trip anything else re-states every balance on it by silently renaming the
--     units. Filling from `events_instance_setting` instead looks equivalent -
--     #25's 409 refused to let the instance base drift away from the recorded
--     ones, so on a healthy database the two agree - and it is equivalent right
--     up until the one database where they do not, which is the kind of
--     reasoning that produces wrong money. The `upgrade` job asserts that each
--     trip's currency and its recorded base survive this migration unchanged, so
--     a backfill that reached for a constant or for the setting goes red there
--     rather than in somebody's budget.
--
--     For an event with NO expenses there is nothing recorded to preserve, so it
--     takes the instance setting - exactly what it would have got had it been
--     created one release later - and `CHF` when no setting row exists, which is
--     `DEFAULT_BASE_CURRENCY` in server/domain/instance-settings.ts.
--
--   events_expense.fx_rate_source - `fetched` for every existing row, which is
--     the CONSERVATIVE label rather than an accurate one. The column records
--     whether a person stated the figure, and nothing in the old schema
--     distinguished a hand-typed rate from a looked-up one, so there is nothing
--     to recover. `fetched` means "nobody has told us this was checked against a
--     statement", which is true of every row here; `manual` would be a claim
--     about verification that never happened.
--
-- The DEFAULT is dropped again on that column immediately. A default left on a
-- NOT NULL column is a silent-wrong-value generator: an insert that sets the
-- amount and forgets where its rate came from would inherit `fetched` rather
-- than aborting, which is the whole reason the four conversion columns on that
-- table carry no defaults.
--
-- No foreign key and no unique index here, so the 42830 constraint-before-index
-- trap documented in 0007's header does not apply.

ALTER TABLE "events_event" ADD COLUMN "currency" text;--> statement-breakpoint

-- An event that holds expenses keeps the currency they were converted into.
-- `DISTINCT ON` over the grouped counts, so an event whose rows somehow disagree
-- (unreachable through #25's refusal, and this is a migration, not a wish) takes
-- the currency most of its money is already in rather than an arbitrary row's.
UPDATE "events_event" AS e
   SET "currency" = x."base_currency"
  FROM (
    SELECT DISTINCT ON ("event_id") "event_id", "base_currency"
      FROM "events_expense"
     GROUP BY "event_id", "base_currency"
     ORDER BY "event_id", count(*) DESC, "base_currency"
  ) AS x
 WHERE x."event_id" = e."id";--> statement-breakpoint

-- Everything else: what a new event would be created with today.
UPDATE "events_event"
   SET "currency" = coalesce(
         (SELECT "base_currency" FROM "events_instance_setting" ORDER BY "id" LIMIT 1),
         'CHF'
       )
 WHERE "currency" IS NULL;--> statement-breakpoint

ALTER TABLE "events_event" ALTER COLUMN "currency" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "events_expense" ADD COLUMN "fx_rate_source" text DEFAULT 'fetched' NOT NULL;--> statement-breakpoint
ALTER TABLE "events_expense" ALTER COLUMN "fx_rate_source" DROP DEFAULT;
