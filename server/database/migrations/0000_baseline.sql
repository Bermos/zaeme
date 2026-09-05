-- zäme baseline. One migration, one database, owned by this repo.
--
-- The chain starts here on purpose. zäme's tables lived for two months inside
-- the Enterprise monorepo's shared Postgres, and before that in this repo under
-- unprefixed names and real PG enum types. Neither history is worth carrying:
-- the shared database is gone, and the pre-monorepo chain describes a schema
-- this code no longer has. So: 15 `events_*` tables, 4 `zaeme_*` auth tables,
-- text-with-enum columns throughout, nothing else.
--
-- Forward-only and idempotent. Kitchen runs the chain as a deploy task
-- (kitchen.json) and never runs a "down" step, on a rollback or otherwise.

CREATE TABLE IF NOT EXISTS "events_contribution" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"quantity" text,
	"note" text,
	"claimed_by_name" text,
	"claimed_by_email" text,
	"claimed_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_by_guest_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_date_option" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_date_vote" (
	"id" text PRIMARY KEY NOT NULL,
	"option_id" text NOT NULL,
	"event_id" text NOT NULL,
	"guest_name" text NOT NULL,
	"guest_email" text NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_event" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'hosted' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"description" text,
	"poster_url" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"location" text,
	"venue_station" text,
	"ticket_url" text,
	"performer_note" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"parent_id" text,
	"cadence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_event_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_event_planner" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'co_planner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_expense" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CHF' NOT NULL,
	"paid_by_name" text NOT NULL,
	"paid_by_email" text NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"created_by_guest_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_expense_share" (
	"id" text PRIMARY KEY NOT NULL,
	"expense_id" text NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_ical_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_ical_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"token" text NOT NULL,
	"label" text,
	"email" text,
	"name" text,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'general' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_media" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"file_name" text NOT NULL,
	"caption" text,
	"taken_at" timestamp with time zone,
	"uploaded_by_user_id" text,
	"uploaded_by_rsvp_id" text,
	"assigned_rsvp_id" text,
	"timeline_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_media_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_message" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_planner_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"token" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'co_planner' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"accepted_by_user_id" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_planner_invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_rsvp" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"invite_id" text,
	"user_id" text,
	"guest_name" text,
	"guest_email" text,
	"status" text NOT NULL,
	"plus_one" boolean DEFAULT false NOT NULL,
	"plus_one_name" text,
	"dietary" text,
	"accessibility" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_series_member" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_timeline_item" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"location" text,
	"type" text DEFAULT 'other' NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"poll_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zaeme_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zaeme_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "zaeme_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zaeme_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "zaeme_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zaeme_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_contribution" ADD CONSTRAINT "events_contribution_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_date_option" ADD CONSTRAINT "events_date_option_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_date_vote" ADD CONSTRAINT "events_date_vote_option_id_events_date_option_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."events_date_option"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_date_vote" ADD CONSTRAINT "events_date_vote_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_event_planner" ADD CONSTRAINT "events_event_planner_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_expense" ADD CONSTRAINT "events_expense_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_expense_share" ADD CONSTRAINT "events_expense_share_expense_id_events_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."events_expense"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_expense_share" ADD CONSTRAINT "events_expense_share_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_invite" ADD CONSTRAINT "events_invite_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_media" ADD CONSTRAINT "events_media_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_media" ADD CONSTRAINT "events_media_uploaded_by_rsvp_id_events_rsvp_id_fk" FOREIGN KEY ("uploaded_by_rsvp_id") REFERENCES "public"."events_rsvp"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_media" ADD CONSTRAINT "events_media_assigned_rsvp_id_events_rsvp_id_fk" FOREIGN KEY ("assigned_rsvp_id") REFERENCES "public"."events_rsvp"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_media" ADD CONSTRAINT "events_media_timeline_item_id_events_timeline_item_id_fk" FOREIGN KEY ("timeline_item_id") REFERENCES "public"."events_timeline_item"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_message" ADD CONSTRAINT "events_message_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_planner_invite" ADD CONSTRAINT "events_planner_invite_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_rsvp" ADD CONSTRAINT "events_rsvp_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_rsvp" ADD CONSTRAINT "events_rsvp_invite_id_events_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."events_invite"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_series_member" ADD CONSTRAINT "events_series_member_series_id_events_event_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events_timeline_item" ADD CONSTRAINT "events_timeline_item_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "zaeme_account" ADD CONSTRAINT "zaeme_account_user_id_zaeme_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."zaeme_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "zaeme_session" ADD CONSTRAINT "zaeme_session_user_id_zaeme_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."zaeme_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_contribution_event_idx" ON "events_contribution" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_contribution_claimed_email_idx" ON "events_contribution" USING btree ("claimed_by_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_date_option_event_idx" ON "events_date_option" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_date_vote_option_idx" ON "events_date_vote" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_date_vote_event_idx" ON "events_date_vote" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_date_vote_email_idx" ON "events_date_vote" USING btree ("guest_email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_date_vote_option_email_unique" ON "events_date_vote" USING btree ("option_id","guest_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_event_slug_idx" ON "events_event" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_event_status_idx" ON "events_event" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_event_parent_idx" ON "events_event" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_event_planner_event_idx" ON "events_event_planner" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_event_planner_user_idx" ON "events_event_planner" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_expense_event_idx" ON "events_expense" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_expense_paid_by_email_idx" ON "events_expense" USING btree ("paid_by_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_expense_share_expense_idx" ON "events_expense_share" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_expense_share_event_idx" ON "events_expense_share" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_expense_share_email_idx" ON "events_expense_share" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_expense_share_expense_email_unique" ON "events_expense_share" USING btree ("expense_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_ical_token_user_idx" ON "events_ical_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_ical_token_email_idx" ON "events_ical_token" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_ical_token_user_unique" ON "events_ical_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_ical_token_email_unique" ON "events_ical_token" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_invite_event_idx" ON "events_invite" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_invite_email_idx" ON "events_invite" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_media_event_idx" ON "events_media" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_media_type_idx" ON "events_media" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_media_status_idx" ON "events_media" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_media_taken_at_idx" ON "events_media" USING btree ("taken_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_media_assigned_rsvp_idx" ON "events_media" USING btree ("assigned_rsvp_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_media_timeline_item_idx" ON "events_media" USING btree ("timeline_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_message_event_idx" ON "events_message" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_planner_invite_event_idx" ON "events_planner_invite" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_rsvp_event_idx" ON "events_rsvp" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_rsvp_user_idx" ON "events_rsvp" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_rsvp_guest_email_idx" ON "events_rsvp" USING btree ("guest_email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_rsvp_event_user_unique" ON "events_rsvp" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_rsvp_event_email_unique" ON "events_rsvp" USING btree ("event_id","guest_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_series_member_series_idx" ON "events_series_member" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_series_member_series_email_unique" ON "events_series_member" USING btree ("series_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_timeline_item_event_idx" ON "events_timeline_item" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_timeline_item_sort_idx" ON "events_timeline_item" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_account_user_idx" ON "zaeme_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_session_user_idx" ON "zaeme_session" USING btree ("user_id");