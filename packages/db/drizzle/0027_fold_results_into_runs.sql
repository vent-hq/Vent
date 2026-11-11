ALTER TABLE "runs" ADD COLUMN "result_json" jsonb;--> statement-breakpoint
UPDATE "runs" SET "result_json" = "scenario_results"."metrics_json" FROM "scenario_results" WHERE "scenario_results"."run_id" = "runs"."id";--> statement-breakpoint
DROP TABLE "scenario_results" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_access_token_id_access_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_access_token_id_access_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "access_token_id";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "closed_at";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "access_token_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "aggregate_json";--> statement-breakpoint
DROP TYPE "public"."scenario_status";
