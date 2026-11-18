CREATE TABLE `setup_handoff` (
	`lookup_id` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `setup_handoff_expiry_idx` ON `setup_handoff` (`expires_at`);