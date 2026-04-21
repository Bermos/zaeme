CREATE TYPE "public"."media_status" AS ENUM('pending', 'ready');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('photo', 'video', 'document', 'ticket');--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" "media_type" NOT NULL,
	"status" "media_status" DEFAULT 'pending' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"file_name" text NOT NULL,
	"caption" text,
	"taken_at" timestamp with time zone,
	"uploaded_by_user_id" text,
	"uploaded_by_rsvp_id" text,
	"assigned_rsvp_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_rsvp_id_rsvp_id_fk" FOREIGN KEY ("uploaded_by_rsvp_id") REFERENCES "public"."rsvp"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_assigned_rsvp_id_rsvp_id_fk" FOREIGN KEY ("assigned_rsvp_id") REFERENCES "public"."rsvp"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_eventId_idx" ON "media" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "media_type_idx" ON "media" USING btree ("type");--> statement-breakpoint
CREATE INDEX "media_status_idx" ON "media" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_takenAt_idx" ON "media" USING btree ("taken_at");--> statement-breakpoint
CREATE INDEX "media_assignedRsvpId_idx" ON "media" USING btree ("assigned_rsvp_id");