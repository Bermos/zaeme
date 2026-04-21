CREATE TABLE "ical_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ical_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "ical_token" ADD CONSTRAINT "ical_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ical_token_userId_idx" ON "ical_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ical_token_email_idx" ON "ical_token" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "ical_token_user_unique" ON "ical_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ical_token_email_unique" ON "ical_token" USING btree ("email");