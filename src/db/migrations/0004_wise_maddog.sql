CREATE TABLE "vendor_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_user_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "vendor_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vendor_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "vendor_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "access_token_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_sessions" ADD CONSTRAINT "vendor_sessions_vendor_user_id_vendor_users_id_fk" FOREIGN KEY ("vendor_user_id") REFERENCES "public"."vendor_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_sessions" ADD CONSTRAINT "vendor_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_sessions_user_idx" ON "vendor_sessions" USING btree ("vendor_user_id");--> statement-breakpoint
CREATE INDEX "vendor_users_tenant_idx" ON "vendor_users" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD CONSTRAINT "delivery_partners_access_token_unique" UNIQUE("access_token");