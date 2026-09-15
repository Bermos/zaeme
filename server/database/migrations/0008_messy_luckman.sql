-- Searching for a place instead of typing its name (#32).
--
-- ADDITIVE, and the two statements against an EXISTING table are additive in
-- the strongest sense available: both are about `events_place.osm_type` and
-- `events_place.osm_id`, which #30 created and which NOTHING HAS EVER WRITTEN.
-- Every row on every database this migration will meet has NULL in both, so
-- neither the CHECK nor the unique index can find a row to refuse. That is also
-- why this is the moment to add them and not later: once the search below is
-- shipping references, "one OSM feature is one place per event" is a rule that
-- could fail to be established against real duplicates, at which point it is a
-- data-cleanup migration and somebody's judgement about which pin to drop.
--
-- Statement by statement, against a database with rows in it — which is the
-- only kind a deploy ever meets (the `upgrade` job in .github/workflows/ci.yml
-- runs this against one):
--
--   * `CREATE TABLE zaeme_geocode_cache` is a new, empty table with no foreign
--     key to anything. Nothing existing is read, locked or rewritten.
--   * the CHECK `(osm_type is null) = (osm_id is null)` is validated against
--     every existing row, all of which have both NULL: `true = true`.
--   * the UNIQUE INDEX is PARTIAL on `osm_id is not null`, so it is built over
--     zero rows — and stays small afterwards, since it indexes only the places
--     somebody looked up. Postgres counts two NULLs as distinct by default, so
--     a NON-partial index would today permit the same set of rows; the
--     predicate is here to say WHICH rows the rule is about, and so that the
--     rule survives an index rebuilt one day with `NULLS NOT DISTINCT`, which
--     would otherwise refuse every hand-typed place on a trip after the first.
--
-- NO COMPOSITE FOREIGN KEY IN HERE, which is the trap `0007_useful_loa.sql`
-- documents at length: drizzle-kit emits every constraint before every index,
-- and a foreign key whose target index does not exist yet aborts with 42830 on
-- any database at all. This migration adds no foreign key, so the generated
-- order needed no correction — check this by hand again the next time one is
-- added, because nothing in CI catches it except running scripts/migrate.mjs.
--
-- Re-runnable in the only sense that matters: drizzle records what it applied
-- and never re-applies it, so a retry of the Kitchen `migrate` task is a no-op,
-- which the `upgrade` job asserts on the line the migrator prints.

CREATE TABLE "zaeme_geocode_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"query" text NOT NULL,
	"results" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "zaeme_geocode_cache_expires_idx" ON "zaeme_geocode_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_place_event_osm_unique" ON "events_place" USING btree ("event_id","osm_type","osm_id") WHERE osm_id is not null;--> statement-breakpoint
ALTER TABLE "events_place" ADD CONSTRAINT "events_place_osm_ref_pair" CHECK ((osm_type is null) = (osm_id is null));