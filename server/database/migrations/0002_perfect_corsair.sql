CREATE TYPE "public"."rsvp_status" AS ENUM('yes', 'maybe', 'no', 'cheering');--> statement-breakpoint
CREATE TABLE "invite" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"token" text NOT NULL,
	"label" text,
	"email" text,
	"name" text,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "rsvp" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"invite_id" text,
	"user_id" text,
	"guest_name" text,
	"guest_email" text,
	"status" "rsvp_status" NOT NULL,
	"plus_one" boolean DEFAULT false NOT NULL,
	"plus_one_name" text,
	"dietary" text,
	"accessibility" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp" ADD CONSTRAINT "rsvp_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp" ADD CONSTRAINT "rsvp_invite_id_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invite"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp" ADD CONSTRAINT "rsvp_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_eventId_idx" ON "invite" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "invite_email_idx" ON "invite" USING btree ("email");--> statement-breakpoint
CREATE INDEX "rsvp_eventId_idx" ON "rsvp" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "rsvp_userId_idx" ON "rsvp" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rsvp_guestEmail_idx" ON "rsvp" USING btree ("guest_email");--> statement-breakpoint
CREATE UNIQUE INDEX "rsvp_event_user_unique" ON "rsvp" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rsvp_event_email_unique" ON "rsvp" USING btree ("event_id","guest_email");