DROP TABLE "artifacts" CASCADE;--> statement-breakpoint
ALTER TABLE "access_tokens" DROP COLUMN "is_anonymous";--> statement-breakpoint
ALTER TABLE "access_tokens" DROP COLUMN "run_limit";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "config_json";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "source_type";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "relay_token";--> statement-breakpoint
ALTER TABLE "scenario_results" DROP COLUMN "test_type";--> statement-breakpoint
DROP TYPE "public"."source_type";