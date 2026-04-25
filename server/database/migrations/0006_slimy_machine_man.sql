CREATE TYPE "public"."date_poll_response" AS ENUM('yes', 'if_need_be', 'no');--> statement-breakpoint
CREATE TABLE "date_poll" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"question" text,
	"deadline" timestamp with time zone,
	"decided_slot_id" text,
	"closed_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_poll_response" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"slot_id" text NOT NULL,
	"invite_id" text,
	"user_id" text,
	"guest_name" text,
	"guest_email" text,
	"response" date_poll_response NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_poll_slot" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "date_poll" ADD CONSTRAINT "date_poll_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll" ADD CONSTRAINT "date_poll_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_response" ADD CONSTRAINT "date_poll_response_poll_id_date_poll_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."date_poll"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_response" ADD CONSTRAINT "date_poll_response_slot_id_date_poll_slot_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."date_poll_slot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_response" ADD CONSTRAINT "date_poll_response_invite_id_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invite"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_response" ADD CONSTRAINT "date_poll_response_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_slot" ADD CONSTRAINT "date_poll_slot_poll_id_date_poll_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."date_poll"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "date_poll_event_unique" ON "date_poll" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "date_poll_response_pollId_idx" ON "date_poll_response" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "date_poll_response_slotId_idx" ON "date_poll_response" USING btree ("slot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "date_poll_response_slot_user_unique" ON "date_poll_response" USING btree ("slot_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "date_poll_response_slot_email_unique" ON "date_poll_response" USING btree ("slot_id","guest_email");--> statement-breakpoint
CREATE INDEX "date_poll_slot_pollId_idx" ON "date_poll_slot" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "date_poll_slot_sortOrder_idx" ON "date_poll_slot" USING btree ("poll_id","sort_order","starts_at");