-- The budget becomes a double-entry ledger with accounts (#61).
--
-- This restructures both money tables rather than adding to them, so the file
-- is hand-extended from what `pnpm db:generate` produced. The generated version
-- was three statements that would have aborted on any database with a row in
-- it: `ADD COLUMN account_id text NOT NULL` with nothing to put in it, and two
-- `DROP COLUMN`s taking the name and the email that a backfill needs to find
-- the account. This file runs as the Kitchen `migrate` task, where a failed
-- task strands production on the previous release, so the order below is the
-- point:
--
--   1. create `events_account`
--   2. seed the category and rounding accounts for every event that exists
--   3. create a member account per identity that already touches money
--   4. add `account_id` NULLABLE, point every existing share row at its member
--      account, and only then make it NOT NULL
--   5. write the sides of each entry the old shape left implicit — the payer's
--      credit, the category debit and credit, and the rounding residual — so
--      every existing entry sums to zero like every new one will
--   6. drop what the accounts replaced: `events_expense.category` and the name
--      and email each line used to repeat
--
-- Step 5 needs `name` and `email` to stop being NOT NULL before it runs — a
-- credit line has no person to name — while step 4 needs `email` to still hold
-- the values it matches on. Hence the two `DROP NOT NULL`s in between: the
-- columns are read, then loosened, then written around, then dropped.
--
-- There is NO `DEFAULT` on `account_id` at any point. The pattern #25 and #26
-- used (add with a default, backfill, drop the default) exists for a column
-- whose correct historical value is a constant — `split_mode` was `'even'` for
-- every row that predated it. There is no constant here: the right account is a
-- different row per expense, so the column is added nullable, filled, and then
-- made NOT NULL. A backfill that leaves any row unmatched fails on
-- `SET NOT NULL`, loudly, which is the failure to want.
--
-- drizzle's migrator wraps the whole pending set in one transaction, so this
-- file cannot half-apply — and the temp table below can therefore be
-- `ON COMMIT DROP`.
CREATE TABLE "events_account" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events_account" ADD CONSTRAINT "events_account_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_account_event_idx" ON "events_account" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_account_event_email_unique" ON "events_account" USING btree ("event_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "events_account_event_category_name_unique" ON "events_account" USING btree ("event_id","name") WHERE kind = 'category';--> statement-breakpoint
CREATE UNIQUE INDEX "events_account_event_rounding_unique" ON "events_account" USING btree ("event_id") WHERE kind = 'rounding';--> statement-breakpoint
INSERT INTO "events_account" ("id", "event_id", "kind", "name", "email", "is_system")
SELECT md5(random()::text || clock_timestamp()::text || e."id" || c."name"),
       e."id", 'category', c."name", NULL, c."name" = 'Uncategorised'
  FROM "events_event" e
  CROSS JOIN (VALUES ('Travel'), ('Accommodation'), ('Food'), ('Tickets'), ('Uncategorised')) AS c("name");--> statement-breakpoint
INSERT INTO "events_account" ("id", "event_id", "kind", "name", "email", "is_system")
SELECT md5(random()::text || clock_timestamp()::text || e."id"), e."id", 'rounding', 'Rounding', NULL, true
  FROM "events_event" e;--> statement-breakpoint
INSERT INTO "events_account" ("id", "event_id", "kind", "name", "email", "is_system")
SELECT md5(random()::text || clock_timestamp()::text || m."event_id" || m."email"),
       m."event_id", 'member', m."name", m."email", false
  FROM (
    SELECT DISTINCT ON (x."event_id", lower(x."email")) x."event_id", lower(x."email") AS "email", x."name"
      FROM (
        SELECT "event_id", "paid_by_email" AS "email", "paid_by_name" AS "name", "created_at" FROM "events_expense"
        UNION ALL
        SELECT "event_id", "email", "name", "created_at" FROM "events_expense_share"
      ) x
     ORDER BY x."event_id", lower(x."email"), x."created_at" DESC
  ) m;--> statement-breakpoint
ALTER TABLE "events_expense_share" ADD COLUMN "account_id" text;--> statement-breakpoint
UPDATE "events_expense_share" s
   SET "account_id" = a."id"
  FROM "events_account" a
 WHERE a."event_id" = s."event_id" AND a."kind" = 'member' AND a."email" = lower(s."email");--> statement-breakpoint
ALTER TABLE "events_expense_share" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events_expense_share" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
CREATE TEMP TABLE "_zaeme_entry_61" ON COMMIT DROP AS
SELECT x."id" AS "expense_id",
       x."event_id",
       x."amount_cents",
       x."amount_base_cents",
       x."created_at",
       lower(x."paid_by_email") AS "payer_email",
       CASE lower(x."category")
         WHEN 'travel' THEN 'Travel'
         WHEN 'accommodation' THEN 'Accommodation'
         WHEN 'food' THEN 'Food'
         WHEN 'tickets' THEN 'Tickets'
         ELSE 'Uncategorised'
       END AS "category_name",
       COALESCE(sum(s."amount_base_cents"), 0)::int AS "owed_base"
  FROM "events_expense" x
  LEFT JOIN "events_expense_share" s ON s."expense_id" = x."id"
 GROUP BY x."id";--> statement-breakpoint
INSERT INTO "events_expense_share" ("id", "expense_id", "event_id", "account_id", "amount_cents", "amount_base_cents", "weight", "created_at")
SELECT md5(random()::text || clock_timestamp()::text || t."expense_id" || 'payer'),
       t."expense_id", t."event_id", a."id", -t."amount_cents", -t."owed_base", NULL, t."created_at"
  FROM "_zaeme_entry_61" t
  JOIN "events_account" a
    ON a."event_id" = t."event_id" AND a."kind" = 'member' AND a."email" = t."payer_email";--> statement-breakpoint
INSERT INTO "events_expense_share" ("id", "expense_id", "event_id", "account_id", "amount_cents", "amount_base_cents", "weight", "created_at")
SELECT md5(random()::text || clock_timestamp()::text || t."expense_id" || 'cost'),
       t."expense_id", t."event_id", a."id", t."amount_cents", t."amount_base_cents", NULL, t."created_at"
  FROM "_zaeme_entry_61" t
  JOIN "events_account" a
    ON a."event_id" = t."event_id" AND a."kind" = 'category' AND a."name" = t."category_name";--> statement-breakpoint
INSERT INTO "events_expense_share" ("id", "expense_id", "event_id", "account_id", "amount_cents", "amount_base_cents", "weight", "created_at")
SELECT md5(random()::text || clock_timestamp()::text || t."expense_id" || 'spread'),
       t."expense_id", t."event_id", a."id", -t."amount_cents", -t."owed_base", NULL, t."created_at"
  FROM "_zaeme_entry_61" t
  JOIN "events_account" a
    ON a."event_id" = t."event_id" AND a."kind" = 'category' AND a."name" = t."category_name";--> statement-breakpoint
INSERT INTO "events_expense_share" ("id", "expense_id", "event_id", "account_id", "amount_cents", "amount_base_cents", "weight", "created_at")
SELECT md5(random()::text || clock_timestamp()::text || t."expense_id" || 'round'),
       t."expense_id", t."event_id", a."id", 0, t."owed_base" - t."amount_base_cents", NULL, t."created_at"
  FROM "_zaeme_entry_61" t
  JOIN "events_account" a ON a."event_id" = t."event_id" AND a."kind" = 'rounding'
 WHERE t."owed_base" <> t."amount_base_cents";--> statement-breakpoint
ALTER TABLE "events_expense_share" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events_expense_share" ADD CONSTRAINT "events_expense_share_account_id_events_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."events_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_expense_share_account_idx" ON "events_expense_share" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_expense_share_expense_account_debit_unique" ON "events_expense_share" USING btree ("expense_id","account_id") WHERE amount_cents >= 0;--> statement-breakpoint
CREATE UNIQUE INDEX "events_expense_share_expense_account_credit_unique" ON "events_expense_share" USING btree ("expense_id","account_id") WHERE amount_cents < 0;--> statement-breakpoint
DROP INDEX "events_expense_share_email_idx";--> statement-breakpoint
DROP INDEX "events_expense_share_expense_email_unique";--> statement-breakpoint
ALTER TABLE "events_expense" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "events_expense_share" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "events_expense_share" DROP COLUMN "email";
