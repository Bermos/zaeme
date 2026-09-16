-- Attach the receipt to the expense (#29).
--
-- ONE NULLABLE COLUMN AND NOTHING ELSE. There is no data: the pin did not exist
-- before this release, so every existing `events_media` row is correct with
-- `expense_id` NULL and there is nothing to backfill (owner, 2026-09-14).
--
-- What that means against a database with rows in it, which is the only kind a
-- deploy ever meets (the `upgrade` job in .github/workflows/ci.yml runs this
-- against one):
--
--   * `ADD COLUMN "expense_id" text` is NULLABLE with no default, so it is a
--     catalogue change: no table rewrite, no row visited, nothing for an
--     existing row to violate. The contrast is `ADD COLUMN ... NOT NULL` with
--     no default, which aborts the moment one row exists and would strand
--     production on the previous release.
--   * the foreign key validates against a column that is NULL on every
--     existing row, so it has nothing to check.
--   * the index is built over a column that is NULL everywhere.
--
-- THE 42830 TRAP DOCUMENTED IN 0007's HEADER DOES NOT APPLY. That one bites a
-- foreign key whose REFERENCED columns have no unique index yet; this key
-- references `events_expense("id")`, which is that table's PRIMARY KEY and has
-- carried its implicit unique index since 0000. The generated order is
-- therefore safe as written, and was checked by hand rather than assumed.
--
-- `ON DELETE set null` is the behaviour the issue asked for and the whole of
-- what happens to a receipt when its expense goes away: the photo stays in the
-- gallery it was uploaded to, un-pinned. It is also why this column can never
-- strand an object in the store that nothing points at — the object was already
-- a gallery item before it was a receipt, and `DELETE /api/host/events/{slug}/
-- media/{id}` is still the one thing that removes both the row and the bytes.

ALTER TABLE "events_media" ADD COLUMN "expense_id" text;--> statement-breakpoint
ALTER TABLE "events_media" ADD CONSTRAINT "events_media_expense_id_events_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."events_expense"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_media_expense_idx" ON "events_media" USING btree ("expense_id");