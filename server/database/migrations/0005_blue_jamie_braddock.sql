CREATE TYPE "public"."timeline_item_type" AS ENUM('transport', 'activity', 'accommodation', 'meal', 'other');--> statement-breakpoint
CREATE TABLE "timeline_item" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"location" text,
	"type" timeline_item_type DEFAULT 'other' NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"poll_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "timeline_item_id" text;--> statement-breakpoint
ALTER TABLE "timeline_item" ADD CONSTRAINT "timeline_item_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timeline_item_eventId_idx" ON "timeline_item" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "timeline_item_sortOrder_idx" ON "timeline_item" USING btree ("event_id","sort_order");--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_timeline_item_id_timeline_item_id_fk" FOREIGN KEY ("timeline_item_id") REFERENCES "public"."timeline_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_timelineItemId_idx" ON "media" USING btree ("timeline_item_id");