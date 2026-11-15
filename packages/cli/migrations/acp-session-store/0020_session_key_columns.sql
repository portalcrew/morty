CREATE TABLE `command` (
	`command_id` text PRIMARY KEY NOT NULL,
	`harness` text NOT NULL,
	`session_id` text NOT NULL,
	`command_hash` text NOT NULL,
	`attempt_id` text NOT NULL,
	`admission_order` integer NOT NULL,
	`fate` text NOT NULL,
	`started_at` text,
	CONSTRAINT "command_fate" CHECK("command"."fate" IN ('pending', 'started', 'cancelled', 'interrupted-before-start', 'settled-before-start', 'settled-after-start')),
	CONSTRAINT "command_started_at" CHECK(("command"."fate" IN ('started', 'settled-after-start')) = ("command"."started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `command_admission_order_idx` ON `command` (`admission_order`);--> statement-breakpoint
CREATE INDEX `command_session_idx` ON `command` (`harness`,`session_id`,`admission_order`);--> statement-breakpoint
CREATE TABLE `command_outcome` (
	`command_id` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_live_event_position_allocation` (
	`allocated_position` integer DEFAULT 10000 NOT NULL,
	`harness` text NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`harness`, `session_id`)
);
