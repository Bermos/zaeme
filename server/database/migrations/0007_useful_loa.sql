-- Places, and the legs between them (#30).
--
-- ADDITIVE, and deliberately: two new tables and ONE new nullable column. There
-- is nothing to backfill, because there is nothing this schema used to say a
-- different way — an itinerary had no places at all, and `location` stays
-- exactly where it was as the free-text fallback.
--
-- What that means against a database with rows in it, which is the only kind a
-- deploy ever meets (the `upgrade` job in .github/workflows/ci.yml runs this
-- against one):
--
--   * `ALTER TABLE events_timeline_item ADD COLUMN place_id text` is NULLABLE
--     with no default, so it is a catalogue change: no table rewrite, no row
--     visited, and nothing for an existing row to violate. The contrast is
--     `ADD COLUMN … NOT NULL` with no default, which aborts the moment one row
--     exists and would strand production on the previous release.
--   * the foreign key added to that column validates against a column that is
--     NULL on every existing row, so it has nothing to check.
--   * both new tables are empty, so their constraints and indexes are free —
--     including the two CHECKs, which are validated against no rows at all.
--
-- It is therefore re-runnable in the only sense that matters here — drizzle
-- records what it has applied and never re-applies it — and a retry of the
-- Kitchen `migrate` task is a no-op, which the `upgrade` job asserts on the
-- line the migrator prints rather than on its exit code.

CREATE TABLE "events_itinerary_leg" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"from_place_id" text,
	"to_place_id" text,
	"mode" text NOT NULL,
	"departs_at" timestamp with time zone,
	"arrives_at" timestamp with time zone,
	"duration_minutes" integer,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_planned" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_itinerary_leg_distinct_endpoints" CHECK (from_place_id is null or from_place_id <> to_place_id)
);
--> statement-breakpoint
CREATE TABLE "events_place" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"osm_type" text,
	"osm_id" text,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_place_coordinates_pair" CHECK ((lat is null) = (lng is null))
);
--> statement-breakpoint
-- The unique index the two composite foreign keys below REFERENCE, moved ahead
-- of them by hand. drizzle-kit emits every constraint before every index, and
-- Postgres refuses a foreign key whose target has no unique constraint yet
-- (`42830`, "there is no unique constraint matching given keys"). In the
-- generated order this migration aborts on its first foreign key — on an empty
-- database and a full one alike — which as the Kitchen `migrate` task means a
-- deploy that strands production on the previous release. Same set of
-- statements and the same final shape, so the snapshot still matches and
-- `pnpm db:generate` still reports nothing to write.
--
-- `0006_red_redwing.sql` has the same shape and got away with it: its
-- composite foreign key targets an index created in an EARLIER migration.
-- Check this ordering by hand every time a composite foreign key is added.
CREATE UNIQUE INDEX "events_place_event_id_unique" ON "events_place" USING btree ("event_id","id");
--> statement-breakpoint
ALTER TABLE "events_timeline_item" ADD COLUMN "place_id" text;
--> statement-breakpoint
ALTER TABLE "events_itinerary_leg" ADD CONSTRAINT "events_itinerary_leg_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events_itinerary_leg" ADD CONSTRAINT "events_itinerary_leg_event_from_place_fk" FOREIGN KEY ("event_id","from_place_id") REFERENCES "public"."events_place"("event_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events_itinerary_leg" ADD CONSTRAINT "events_itinerary_leg_event_to_place_fk" FOREIGN KEY ("event_id","to_place_id") REFERENCES "public"."events_place"("event_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events_place" ADD CONSTRAINT "events_place_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "events_itinerary_leg_event_idx" ON "events_itinerary_leg" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "events_itinerary_leg_sort_idx" ON "events_itinerary_leg" USING btree ("event_id","sort_order");
--> statement-breakpoint
CREATE INDEX "events_itinerary_leg_from_idx" ON "events_itinerary_leg" USING btree ("from_place_id");
--> statement-breakpoint
CREATE INDEX "events_itinerary_leg_to_idx" ON "events_itinerary_leg" USING btree ("to_place_id");
--> statement-breakpoint
CREATE INDEX "events_place_event_idx" ON "events_place" USING btree ("event_id");
--> statement-breakpoint
ALTER TABLE "events_timeline_item" ADD CONSTRAINT "events_timeline_item_place_id_events_place_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."events_place"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "events_timeline_item_place_idx" ON "events_timeline_item" USING btree ("place_id");
