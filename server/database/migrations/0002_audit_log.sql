-- The instance audit log (`server/database/schema/audit.ts`): one row per
-- mutating request on a credentialled surface — who, on which surface, against
-- which event, and what the response was. It is the admin surface's "who did
-- what", and the only place an unauthorised ATTEMPT is visible at all.
--
-- Written IF NOT EXISTS, like every step in this chain: Kitchen runs it
-- forward-only and never rolls one back, so each has to survive re-application.
CREATE TABLE IF NOT EXISTS "zaeme_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"surface" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"event_slug" text,
	"status" integer,
	"meta" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_audit_log_at_idx" ON "zaeme_audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_audit_log_actor_idx" ON "zaeme_audit_log" USING btree ("actor_kind","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_audit_log_surface_idx" ON "zaeme_audit_log" USING btree ("surface","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_audit_log_event_idx" ON "zaeme_audit_log" USING btree ("event_slug");