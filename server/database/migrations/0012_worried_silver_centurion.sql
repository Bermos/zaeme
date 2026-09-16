-- What a ticket says, as rows (#35).
--
-- ADDITIVE, and entirely: ONE new table and ONE new index on an existing one.
-- No column is added, none is dropped, none changes type, and nothing is
-- backfilled — a ticket that already exists simply has no detail row, which is
-- the state this table calls "nobody has typed anything in yet" and which every
-- reader has to handle anyway.
--
-- What that means against a database with rows in it, which is the only kind a
-- deploy ever meets (the `upgrade` job in .github/workflows/ci.yml runs this
-- against one):
--
--   * `events_ticket_detail` is empty when it is created, so its constraints
--     and both its indexes are validated against no rows at all.
--   * `CREATE UNIQUE INDEX events_media_event_id_unique` is the one statement
--     here that touches a POPULATED table, and it cannot fail on data: `id` is
--     already the primary key of `events_media`, so `(event_id, id)` is unique
--     by construction whatever is in there. It is an index build — one scan, a
--     SHARE lock on `events_media` for the duration, and no row rewritten.
--     `CONCURRENTLY` is deliberately NOT used: it cannot run inside a
--     transaction block and drizzle's migrator wraps the pending set in one, so
--     asking for it would abort the whole deploy to save a lock held over a
--     table with four figures of rows on the largest instance that exists.
--   * both foreign keys validate against an EMPTY child table, so neither reads
--     `events_event` or `events_media` at all.
--
-- ── THE ORDER IS HAND-EDITED, AND THAT IS THE WHOLE POINT ──────────────────
--
-- drizzle-kit emits every constraint before every index, and Postgres refuses a
-- foreign key whose target has no unique constraint yet (`42830`, "there is no
-- unique constraint matching given keys for referenced table"). As generated,
-- `events_ticket_detail_event_media_fk` names `events_media (event_id, id)`
-- while the unique index backing it is the LAST statement in the file — so this
-- migration aborted on that foreign key, on an empty database and a full one
-- alike, which as the Kitchen `migrate` task means a deploy that strands
-- production on the previous release. The `CREATE UNIQUE INDEX` on
-- `events_media` has been moved ahead of it by hand.
--
-- Same statements and the same final shape, so the snapshot still matches and
-- `pnpm db:generate` still reports nothing to write. `0007_useful_loa.sql` has
-- the identical edit for the identical reason, and its header asks for this to
-- be checked by hand every time a composite foreign key is added. It was; this
-- is the second time that instruction has earned itself.

CREATE TABLE "events_ticket_detail" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"media_id" text NOT NULL,
	"booking_ref" text,
	"carrier" text,
	"seat" text,
	"coach" text,
	"traveller_name" text,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Moved ahead of the composite foreign key that REFERENCES it; see the header.
CREATE UNIQUE INDEX "events_media_event_id_unique" ON "events_media" USING btree ("event_id","id");--> statement-breakpoint
ALTER TABLE "events_ticket_detail" ADD CONSTRAINT "events_ticket_detail_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_ticket_detail" ADD CONSTRAINT "events_ticket_detail_event_media_fk" FOREIGN KEY ("event_id","media_id") REFERENCES "public"."events_media"("event_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_ticket_detail_media_unique" ON "events_ticket_detail" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "events_ticket_detail_event_idx" ON "events_ticket_detail" USING btree ("event_id");
