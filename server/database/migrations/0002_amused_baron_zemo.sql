CREATE TYPE "public"."rsvp_status" AS ENUM('yes', 'maybe', 'no', 'cheering');--> statement-breakpoint
CREATE TABLE "attendee" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"rsvp_status" "rsvp_status" NOT NULL,
	"plus_one" integer DEFAULT 0 NOT NULL,
	"dietary" text,
	"accessibility" text,
	"note" text,
	"invite_id" text,
	"rsvp_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendee_rsvp_token_unique" UNIQUE("rsvp_token")
);
--> statement-breakpoint
CREATE TABLE "event_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_invite_id_event_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."event_invite"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_invite" ADD CONSTRAINT "event_invite_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendee_eventId_idx" ON "attendee" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "attendee_userId_idx" ON "attendee" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attendee_rsvpToken_idx" ON "attendee" USING btree ("rsvp_token");--> statement-breakpoint
CREATE UNIQUE INDEX "attendee_eventId_email_uidx" ON "attendee" USING btree ("event_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "event_invite_eventId_uidx" ON "event_invite" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_invite_token_idx" ON "event_invite" USING btree ("token");