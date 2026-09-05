-- The machine API (ADR-0036): an event may be a PROJECTION of a record that
-- lives in another system. `external_ref` holds that system's id — today only
-- Enterprise's `music_concert.id` — and is the idempotency key that makes a
-- republish patch the same announcement instead of minting a second one.
--
-- Written IF NOT EXISTS, like the baseline: Kitchen runs the chain forward-only
-- and never rolls one back, so every step has to survive being re-applied.
ALTER TABLE "events_event" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
-- The snapshot's hot path orders the owner's events by start time.
CREATE INDEX IF NOT EXISTS "events_event_starts_at_idx" ON "events_event" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_event_external_ref_unique" ON "events_event" USING btree ("external_ref");
