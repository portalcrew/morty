CREATE TABLE `browser_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`transfer_id` text NOT NULL,
	`replaced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_credential_token_hash_unique` ON `browser_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `browser_credential_device_idx` ON `browser_credential` (`device_id`);--> statement-breakpoint
CREATE INDEX `browser_credential_transfer_idx` ON `browser_credential` (`transfer_id`);--> statement-breakpoint
CREATE TABLE `browser_device` (
	`id` text PRIMARY KEY NOT NULL,
	`joined_at` integer NOT NULL,
	`label` text,
	`joined_city` text,
	`joined_country` text,
	`joined_through_transfer_id` text NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE TABLE `computer_connection` (
	`computer_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`connection_epoch` integer NOT NULL,
	`connected_at` integer NOT NULL,
	`disconnected_at` integer
);
--> statement-breakpoint
CREATE TABLE `computer_pairings` (
	`generation` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`computer_id` text NOT NULL,
	`pairing_code_hash` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`creation_idempotency_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `computer_pairings_pairing_code_hash_unique` ON `computer_pairings` (`pairing_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `computer_pairings_creation_idempotency_key_unique` ON `computer_pairings` (`creation_idempotency_key`);--> statement-breakpoint
CREATE TABLE `computer_registrations` (
	`generation` integer PRIMARY KEY NOT NULL,
	`machine_name` text NOT NULL,
	`workspace_name` text NOT NULL,
	`agents_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `computer_revocations` (
	`generation` integer PRIMARY KEY NOT NULL,
	`revoked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daemon_credentials` (
	`generation` integer PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daemon_credentials_token_hash_unique` ON `daemon_credentials` (`token_hash`);--> statement-breakpoint
CREATE TABLE `retired_daemon_credentials` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`successor_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `retired_daemon_credentials_generation` ON `retired_daemon_credentials` (`generation`);--> statement-breakpoint
CREATE TABLE `identity_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`access_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_credential_id` text NOT NULL,
	`replaces_transfer_id` text,
	`cancelled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_code_hash_unique` ON `identity_transfer` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_replaces_transfer_id_unique` ON `identity_transfer` (`replaces_transfer_id`);--> statement-breakpoint
CREATE INDEX `identity_transfer_expiry_idx` ON `identity_transfer` (`expires_at`);--> statement-breakpoint
CREATE TABLE `owner_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_credential_token_hash_unique` ON `owner_credential` (`token_hash`);