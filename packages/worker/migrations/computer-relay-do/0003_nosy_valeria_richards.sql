CREATE TABLE `link_sharer` (
	`link_id` text PRIMARY KEY NOT NULL,
	`holder_kind` text NOT NULL,
	`holder_id` text NOT NULL,
	CONSTRAINT "link_sharer_holder_kind" CHECK("link_sharer"."holder_kind" IN ('owner', 'device'))
);
--> statement-breakpoint
DROP TABLE `link_shared_by_device`;--> statement-breakpoint
DROP TABLE `link_shared_by_owner`;