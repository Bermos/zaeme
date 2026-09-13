-- Registered passkeys (`server/database/schema/auth.ts`): one row per WebAuthn
-- credential, so an account has a way in that does not depend on this instance
-- being able to deliver an email. Before this table, an instance with no mail
-- transport could not be signed in to at all — by anybody, its owner included.
--
-- Column names are the better-auth passkey plugin's field names in snake_case;
-- `credential_id` is `credentialID` on the model, and the drizzle schema is
-- what maps the two. Renaming either side breaks sign-in silently.
--
-- Written IF NOT EXISTS, like every step in this chain: Kitchen runs it
-- forward-only and never rolls one back, so each has to survive re-application.
CREATE TABLE IF NOT EXISTS "zaeme_passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "zaeme_passkey" ADD CONSTRAINT "zaeme_passkey_user_id_zaeme_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."zaeme_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_passkey_user_idx" ON "zaeme_passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zaeme_passkey_credential_idx" ON "zaeme_passkey" USING btree ("credential_id");
