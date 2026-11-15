CREATE TABLE `session_creation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`harness` text NOT NULL,
	`session_id` text NOT NULL
);
