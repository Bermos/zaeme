CREATE TYPE "public"."event_status" AS ENUM('draft', 'polling', 'published', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('hosted', 'concert', 'series');--> statement-breakpoint
CREATE TABLE "event" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"type" "event_type" DEFAULT 'hosted' NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"location" text,
	"venue_station" text,
	"ticket_url" text,
	"performer_note" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"parent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "event_planner" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'co_planner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_planner" ADD CONSTRAINT "event_planner_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_planner" ADD CONSTRAINT "event_planner_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_slug_idx" ON "event" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "event_status_idx" ON "event" USING btree ("status");--> statement-breakpoint
CREATE INDEX "event_parentId_idx" ON "event" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "event_planner_eventId_idx" ON "event_planner" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_planner_userId_idx" ON "event_planner" USING btree ("user_id");