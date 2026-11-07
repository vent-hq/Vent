ALTER TABLE "runs" ADD COLUMN "platform_config_encrypted" jsonb;
--> statement-breakpoint
DROP TABLE "platform_connections";
--> statement-breakpoint
DROP TYPE "platform_connection_status";
