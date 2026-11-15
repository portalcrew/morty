CREATE TABLE `replay_claim` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `replay_claim_expiry_idx` ON `replay_claim` (`expires_at`);--> statement-breakpoint
CREATE TABLE `replay_clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`latest_at` integer NOT NULL,
	CONSTRAINT "replay_clock_single_row" CHECK("replay_clock"."id" = 0)
);
