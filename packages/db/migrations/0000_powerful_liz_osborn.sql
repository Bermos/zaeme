CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'polling', 'published', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('hosted', 'concert', 'series');--> statement-breakpoint
CREATE TYPE "public"."planner_role" AS ENUM('owner', 'co_planner', 'logistics');--> statement-breakpoint
CREATE TYPE "public"."rsvp_status" AS ENUM('yes', 'maybe', 'no', 'cheering');--> statement-breakpoint
CREATE TYPE "public"."travel_commitment_status" AS ENUM('pending', 'confirmed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('photo', 'video', 'document', 'ticket');--> statement-breakpoint
CREATE TYPE "public"."poll_response" AS ENUM('yes', 'if_need_be', 'no');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" "event_type" DEFAULT 'hosted' NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"venue" text,
	"venue_address" text,
	"venue_station" text,
	"venue_latitude" text,
	"venue_longitude" text,
	"ticket_url" text,
	"performer_note" text,
	"parent_id" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"max_attendees" integer,
	"invite_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "event_planners" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "planner_role" DEFAULT 'co_planner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendees" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text,
	"guest_name" text,
	"guest_email" text,
	"rsvp_token" text NOT NULL,
	"rsvp_status" "rsvp_status" NOT NULL,
	"plus_one" integer DEFAULT 0 NOT NULL,
	"dietary_note" text,
	"accessibility_note" text,
	"note" text,
	"origin_station" text,
	"unsubscribed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_group_commitments" (
	"id" text PRIMARY KEY NOT NULL,
	"travel_group_id" text NOT NULL,
	"attendee_id" text NOT NULL,
	"is_taking" "travel_commitment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"hub_station" text NOT NULL,
	"connection_data" jsonb,
	"train_number" text,
	"departure_time" timestamp with time zone,
	"arrival_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendee_pack_items" (
	"id" text PRIMARY KEY NOT NULL,
	"attendee_id" text NOT NULL,
	"title" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizer_todos" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"assignee_id" text,
	"title" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_list_template_items" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"title" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"uploader_attendee_id" text,
	"type" "media_type" NOT NULL,
	"r2_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"filename" text NOT NULL,
	"filesize" text,
	"caption" text,
	"assigned_attendee_id" text,
	"taken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"author_attendee_id" text,
	"body" text NOT NULL,
	"reply_to_id" text,
	"deleted_at" timestamp with time zone,
	"is_announcement" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_poll_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"slot_id" text NOT NULL,
	"attendee_id" text NOT NULL,
	"response" "poll_response" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_poll_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"score" numeric(10, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_polls" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"question" text,
	"deadline" timestamp with time zone,
	"decided_slot_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "date_polls_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "ical_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"attendee_id" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ical_tokens_attendee_id_unique" UNIQUE("attendee_id"),
	CONSTRAINT "ical_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_planners" ADD CONSTRAINT "event_planners_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_planners" ADD CONSTRAINT "event_planners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendees" ADD CONSTRAINT "attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendees" ADD CONSTRAINT "attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_group_commitments" ADD CONSTRAINT "travel_group_commitments_travel_group_id_travel_groups_id_fk" FOREIGN KEY ("travel_group_id") REFERENCES "public"."travel_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_group_commitments" ADD CONSTRAINT "travel_group_commitments_attendee_id_attendees_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "public"."attendees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_groups" ADD CONSTRAINT "travel_groups_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_pack_items" ADD CONSTRAINT "attendee_pack_items_attendee_id_attendees_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "public"."attendees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_todos" ADD CONSTRAINT "organizer_todos_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_list_template_items" ADD CONSTRAINT "pack_list_template_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploader_attendee_id_attendees_id_fk" FOREIGN KEY ("uploader_attendee_id") REFERENCES "public"."attendees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_assigned_attendee_id_attendees_id_fk" FOREIGN KEY ("assigned_attendee_id") REFERENCES "public"."attendees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_attendee_id_attendees_id_fk" FOREIGN KEY ("author_attendee_id") REFERENCES "public"."attendees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_responses" ADD CONSTRAINT "date_poll_responses_slot_id_date_poll_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."date_poll_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_responses" ADD CONSTRAINT "date_poll_responses_attendee_id_attendees_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "public"."attendees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_slots" ADD CONSTRAINT "date_poll_slots_poll_id_date_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."date_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_polls" ADD CONSTRAINT "date_polls_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ical_tokens" ADD CONSTRAINT "ical_tokens_attendee_id_attendees_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "public"."attendees"("id") ON DELETE cascade ON UPDATE no action;