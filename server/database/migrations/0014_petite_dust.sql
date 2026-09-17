-- A bring-list claim is a ROW, so the list can count (#44).
--
-- DESTRUCTIVE, and the SECOND such migration in this chain. It drops
-- `events_contribution.claimed_by_name`, `claimed_by_email` and `claimed_at`.
-- Dropping a column is normally the instance owner's call and this is that
-- call, made: issue #44 quotes them verbatim — "We have no data (except the
-- initial setup) so we don't need to be too careful about backwards
-- compatibility, etc." — so the three columns go rather than being kept beside
-- the new table through a dual-read period nobody would ever come back and end.
-- `0013_short_steel_serpent.sql` made the same call for the same reason and its
-- header is worth reading beside this one.
--
-- WHY THEY CANNOT SURVIVE THE FEATURE. They held ONE claimer: a name, an
-- address and an instant. So an item was claimed by exactly one person or by
-- nobody, and the two questions a potluck actually asks — how much is still
-- missing, and can two of us split the salad — were not expressible at all.
-- `events_contribution_claim` is one row per person per item, unique on
-- `(contribution_id, email)`, and `events_contribution.quantity_needed` beside
-- the existing free-text `quantity` is what makes "2 to go" a number rather
-- than a sentence somebody typed.
--
-- ── IT CARRIES A BACKFILL, AND THE ISSUE SAID IT NEED NOT ──────────────────
--
-- "No backfill" was licence not to be careful about the SHAPE; it is not a
-- reason to throw away data a running instance has. The backfill is one
-- INSERT … SELECT, it runs before the DROPs, and without it every item anybody
-- had already claimed silently becomes unclaimed — which on the guest surface
-- is a party where nobody is bringing anything and four friends re-claim four
-- things somebody already bought. One statement against a worse answer.
--
-- Every backfilled claim is `quantity_claimed = 1` and lands on an item whose
-- `quantity_needed` is NULL (the column is new, so every existing row has
-- none). `contributionTally` reads that pair as "somebody has claimed it",
-- which is precisely what `claimed_by_email IS NOT NULL` meant the day before
-- this migration. The carried-across claims therefore render and behave
-- identically, which is the first acceptance criterion of the issue.
--
-- What this means against a database with rows in it, which is the only kind a
-- deploy ever meets (the `upgrade` job in .github/workflows/ci.yml runs this
-- against one, and `scripts/ci-upgrade-check.mjs` mints a CLAIMED bring-list
-- item through the PREVIOUS release specifically so there is something here for
-- the backfill to carry):
--
--   * `events_contribution_claim` is empty when it is created, so its two
--     foreign keys and its four indexes are validated against no rows at all.
--   * `CREATE UNIQUE INDEX events_contribution_event_id_unique` is the one
--     statement here that touches a POPULATED table, and it cannot fail on
--     data: `id` is already the primary key of `events_contribution`, so
--     `(event_id, id)` is unique by construction whatever is in there. It is an
--     index build — one scan, a SHARE lock for the duration, no row rewritten.
--     `CONCURRENTLY` is deliberately NOT used, for the reason 0012 and 0013
--     give: it cannot run inside a transaction block and drizzle's migrator
--     wraps the pending set in one.
--   * the backfill reads `events_contribution` and writes rows whose shape the
--     composite key already accepts — it takes `event_id` from the very row it
--     points at, so no cross-event row is reachable and no join is needed (the
--     case `0013` had to guard against does not arise here).
--   * `ALTER TABLE … DROP COLUMN` is a catalogue change: no table rewrite and
--     no row visited. `events_contribution_claimed_email_idx` is dropped first,
--     because Postgres will not drop a column an index still names.
--
-- The id is `md5(contribution_id || ':' || email)` for ONE reason: it needs no
-- extension, where `gen_random_uuid()` is core only from PG13. The column is
-- `text`, so a 32-character digest sits in it exactly as a cuid2 does. Being
-- deterministic buys no idempotence — there is no `ON CONFLICT` on this INSERT,
-- so a second run would abort on the primary key. Nothing is going to run it
-- twice: drizzle records what it has applied and wraps the pending set in one
-- transaction, so a failed migration leaves no half-written rows to replay onto.
-- (0013's header says this at length after an earlier draft of it claimed the
-- opposite; the claim is repeated here because the next person to write one of
-- these will read whichever file they open.)
--
-- ── THE ORDER IS HAND-EDITED, AND THAT IS THE WHOLE POINT ──────────────────
--
-- drizzle-kit emits every constraint before every index, and Postgres refuses a
-- foreign key whose target has no unique constraint yet (`42830`, "there is no
-- unique constraint matching given keys for referenced table"). As generated,
-- `events_contribution_claim_event_contribution_fk` names
-- `events_contribution (event_id, id)` while
-- `CREATE UNIQUE INDEX events_contribution_event_id_unique` was the
-- fourth-from-last statement in the file — so this migration aborted on that
-- foreign key, on an empty database and a full one alike, which as the Kitchen
-- `migrate` task is a deploy stranded on the previous release. That index has
-- been moved to the top by hand. `0007`, `0012` and `0013` each carry the
-- identical edit for the identical reason; this is the FOURTH time that
-- instruction has earned itself, and `test/api-boundary.test.ts` now walks
-- every migration in the chain looking for exactly this.
--
-- Same statements and the same final shape, so the snapshot still matches and
-- `pnpm db:generate` still reports nothing to write. The backfill is the one
-- addition, and it writes rows rather than changing a definition.

-- Moved ahead of the composite foreign key that REFERENCES it; see the header.
CREATE UNIQUE INDEX "events_contribution_event_id_unique" ON "events_contribution" USING btree ("event_id","id");--> statement-breakpoint
CREATE TABLE "events_contribution_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"contribution_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"quantity_claimed" integer DEFAULT 1 NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events_contribution" ADD COLUMN "quantity_needed" integer;--> statement-breakpoint
ALTER TABLE "events_contribution" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "events_contribution_claim" ADD CONSTRAINT "events_contribution_claim_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_contribution_claim" ADD CONSTRAINT "events_contribution_claim_event_contribution_fk" FOREIGN KEY ("event_id","contribution_id") REFERENCES "public"."events_contribution"("event_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_contribution_claim_item_email_unique" ON "events_contribution_claim" USING btree ("contribution_id","email");--> statement-breakpoint
CREATE INDEX "events_contribution_claim_contribution_idx" ON "events_contribution_claim" USING btree ("contribution_id");--> statement-breakpoint
CREATE INDEX "events_contribution_claim_event_idx" ON "events_contribution_claim" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_contribution_claim_email_idx" ON "events_contribution_claim" USING btree ("email");--> statement-breakpoint
-- THE BACKFILL, before the columns it reads are dropped. Hand-written; see the
-- header for why it exists at all. `name` is NOT NULL on the new table and
-- `claimed_by_name` was nullable, so an anonymous claim carries its address
-- across rather than becoming a row with no author. `claimed_at` falls back to
-- the item's own `created_at`: nothing else here is closer to the truth, and
-- `now()` would date every historic claim to the deploy.
INSERT INTO "events_contribution_claim" ("id", "event_id", "contribution_id", "name", "email", "quantity_claimed", "claimed_at")
SELECT md5(c."id" || ':' || lower(c."claimed_by_email")), c."event_id", c."id",
       coalesce(c."claimed_by_name", c."claimed_by_email"), lower(c."claimed_by_email"),
       1, coalesce(c."claimed_at", c."created_at")
FROM "events_contribution" c
WHERE c."claimed_by_email" IS NOT NULL;--> statement-breakpoint
DROP INDEX "events_contribution_claimed_email_idx";--> statement-breakpoint
ALTER TABLE "events_contribution" DROP COLUMN "claimed_by_name";--> statement-breakpoint
ALTER TABLE "events_contribution" DROP COLUMN "claimed_by_email";--> statement-breakpoint
ALTER TABLE "events_contribution" DROP COLUMN "claimed_at";
