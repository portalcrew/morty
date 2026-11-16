CREATE TABLE `computer_agent_catalogs` (
	`generation` integer PRIMARY KEY NOT NULL,
	`agents` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `computer_registrations` DROP COLUMN `agents_json`;