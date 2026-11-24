import { mortyReleaseVersionSchema } from "@portalcrew/morty-client/protocol";

const release = mortyReleaseVersionSchema.safeParse(import.meta.env["VITE_MORTY_CLI_VERSION"]);

/**
 * The Morty CLI released with this page, which deployment activates only once it is npm's latest release. Builds
 * outside a release have none, so they never offer an update.
 */
export const mortyReleaseVersion: string | null = release.success ? release.data : null;
