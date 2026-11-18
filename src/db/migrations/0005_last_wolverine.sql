ALTER TYPE "public"."payment_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cf_session_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "auth_token" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_auth_token_unique" UNIQUE("auth_token");