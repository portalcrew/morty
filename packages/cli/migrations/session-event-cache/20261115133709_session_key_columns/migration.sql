CREATE TABLE `session_event_cache` (
	`event_id` text NOT NULL,
	`event_json` text NOT NULL,
	`generation_id` text NOT NULL,
	`harness` text NOT NULL,
	`position` integer NOT NULL,
	`session_id` text NOT NULL,
	CONSTRAINT `session_event_cache_pk` PRIMARY KEY(`harness`, `session_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `session_event_cache_generation_session_position_index` ON `session_event_cache` (`generation_id`,`harness`,`session_id`,`position`);