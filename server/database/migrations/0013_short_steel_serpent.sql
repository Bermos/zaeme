-- Who a ticket is for, as rows (#36).
--
-- DESTRUCTIVE, AND THE ONLY MIGRATION IN THIS CHAIN THAT IS. It drops
-- `events_media.assigned_rsvp_id`. Dropping a column is normally the instance
-- owner's call and this is that call, made: issue #36 quotes them verbatim —
-- "We have no data (except the initial setup) so we don't need to be too
-- careful about backwards compatibility, etc." — so the column goes rather than
-- being kept beside the new table through a dual-read period nobody would ever
-- come back and end.
--
-- ── IT STILL CARRIES A BACKFILL, AND THE ISSUE SAID IT NEED NOT ────────────
--
-- "No backfill" was licence not to be careful about the SHAPE; it is not a
-- reason to throw away data a running instance has. The backfill is one
-- INSERT … SELECT, it runs before the DROP, and without it every ticket
-- somebody had already been given silently becomes a ticket for nobody — which
-- on the guest surface is a friend opening the invite link at the barrier and
-- finding their ticket gone. Dropping them is a worse answer to a question that
-- costs one statement, and it would also leave the `upgrade` job in
-- .github/workflows/ci.yml with nothing to assert about this column but absence.
--
-- What that means against a database with rows in it, which is the only kind a
-- deploy ever meets (the `upgrade` job runs this against one, and
-- `scripts/ci-upgrade-check.mjs` mints a ticket canary through the PREVIOUS
-- release's host surface specifically so there is an assigned ticket here to
-- carry across):
--
--   * `events_ticket_assignment` is empty when it is created, so its three
--     foreign keys and its four indexes are validated against no rows at all.
--   * `CREATE UNIQUE INDEX events_rsvp_event_id_unique` is one of the two
--     statements here that touch a POPULATED table, and it cannot fail on data:
--     `id` is already the primary key of `events_rsvp`, so `(event_id, id)` is
--     unique by construction whatever is in there. It is an index build — one
--     scan, a SHARE lock for the duration, no row rewritten. `CONCURRENTLY` is
--     deliberately NOT used, for the reason 0012 gives: it cannot run inside a
--     transaction block and drizzle's migrator wraps the pending set in one.
--   * the backfill reads `events_media` and `events_rsvp` and writes rows whose
--     shape both composite keys already accept — see the join below.
--   * `ALTER TABLE … DROP COLUMN` is a catalogue change: no table rewrite and
--     no row visited. Its own foreign key and index are dropped first, because
--     Postgres will not drop a column two other objects still name.
--
-- ── THE JOIN IN THE BACKFILL IS NOT DECORATION ─────────────────────────────
--
-- `assigned_rsvp_id` was a PLAIN reference to `events_rsvp (id)` with no event
-- scoping at all, so nothing in the database stopped a ticket on trip A naming
-- an RSVP on trip B — only `assignTicket` did, in TypeScript. The new table's
-- `events_ticket_assignment_event_rsvp_fk` names `(event_id, rsvp_id)` and
-- would REFUSE such a row, which as the Kitchen `migrate` task means a deploy
-- that strands production on the previous release over a row the app cannot
-- have written. So the select joins on BOTH columns: a cross-event assignment,
-- if one exists, is left behind rather than aborting the upgrade. Every
-- assignment the app itself made satisfies the join and comes across.
--
-- The id is `md5(media_id || ':' || rsvp_id)` — deterministic, so it needs no
-- extension (`gen_random_uuid()` is core only from PG13) and a replay against a
-- half-migrated database would produce the same row rather than a second one.
-- The column is `text`, so a 32-character digest sits in it exactly as a cuid2
-- does.
--
-- ── THE ORDER IS HAND-EDITED, AND THAT IS THE WHOLE POINT ──────────────────
--
-- drizzle-kit emits every constraint before every index, and Postgres refuses a
-- foreign key whose target has no unique constraint yet (`42830`, "there is no
-- unique constraint matching given keys for referenced table"). As generated,
-- `events_ticket_assignment_event_rsvp_fk` names `events_rsvp (event_id, id)`
-- while `CREATE UNIQUE INDEX events_rsvp_event_id_unique` was the
-- second-to-last statement in the file — so this migration aborted on that
-- foreign key, on an empty database and a full one alike. That index has been
-- moved to the top by hand. `0007_useful_loa.sql` and `0012` each carry the
-- identical edit for the identical reason; this is the third time that
-- instruction has earned itself. The `events_media (event_id, id)` index the
-- media-side key needs was already created by 0012 and is not repeated here.
--
-- Same statements and the same final shape, so the snapshot still matches and
-- `pnpm db:generate` still reports nothing to write. The backfill is the one
-- addition, and it writes rows rather than changing a definition.

-- Moved ahead of the composite foreign key that REFERENCES it; see the header.
CREATE UNIQUE INDEX "events_rsvp_event_id_unique" ON "events_rsvp" USING btree ("event_id","id");--> statement-breakpoint
CREATE TABLE "events_ticket_assignment" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"media_id" text NOT NULL,
	"rsvp_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events_ticket_assignment" ADD CONSTRAINT "events_ticket_assignment_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_ticket_assignment" ADD CONSTRAINT "events_ticket_assignment_event_media_fk" FOREIGN KEY ("event_id","media_id") REFERENCES "public"."events_media"("event_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_ticket_assignment" ADD CONSTRAINT "events_ticket_assignment_event_rsvp_fk" FOREIGN KEY ("event_id","rsvp_id") REFERENCES "public"."events_rsvp"("event_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_ticket_assignment_media_rsvp_unique" ON "events_ticket_assignment" USING btree ("media_id","rsvp_id");--> statement-breakpoint
CREATE INDEX "events_ticket_assignment_media_idx" ON "events_ticket_assignment" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "events_ticket_assignment_rsvp_idx" ON "events_ticket_assignment" USING btree ("rsvp_id");--> statement-breakpoint
CREATE INDEX "events_ticket_assignment_event_idx" ON "events_ticket_assignment" USING btree ("event_id");--> statement-breakpoint
-- THE BACKFILL, before the column it reads is dropped. Hand-written; see the
-- header for why it exists at all and why it joins on both columns. It carries
-- `events_media.created_at` across as the assignment's own, which is the
-- closest honest answer available: nothing ever recorded when a ticket was
-- assigned, and `now()` would date every historic assignment to the deploy.
INSERT INTO "events_ticket_assignment" ("id", "event_id", "media_id", "rsvp_id", "created_at")
SELECT md5(m."id" || ':' || m."assigned_rsvp_id"), m."event_id", m."id", m."assigned_rsvp_id", m."created_at"
FROM "events_media" m
JOIN "events_rsvp" r ON r."id" = m."assigned_rsvp_id" AND r."event_id" = m."event_id"
WHERE m."assigned_rsvp_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "events_media" DROP CONSTRAINT "events_media_assigned_rsvp_id_events_rsvp_id_fk";
--> statement-breakpoint
DROP INDEX "events_media_assigned_rsvp_idx";--> statement-breakpoint
ALTER TABLE "events_media" DROP COLUMN "assigned_rsvp_id";
