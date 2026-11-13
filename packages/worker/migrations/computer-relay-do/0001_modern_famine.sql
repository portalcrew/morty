CREATE TABLE `link_shared_by_device` (
	`link_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `link_shared_by_owner` (
	`link_id` text PRIMARY KEY NOT NULL,
	`owner_credential_id` text NOT NULL
);
--> statement-breakpoint
DROP INDEX `browser_credential_transfer_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_credential_transfer_idx` ON `browser_credential` (`transfer_id`);--> statement-breakpoint
ALTER TABLE `identity_transfer` DROP COLUMN `created_by_credential_id`;