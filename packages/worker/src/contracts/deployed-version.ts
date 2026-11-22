import * as v from "valibot";

/** Names the Worker version that served a response, so a deployment tells its own responses from an earlier one's. */
export const deployedVersionHeader = "Morty-Version";

const versionMetadataSchema = v.object({ id: v.pipe(v.string(), v.minLength(1)) });

export function deployedVersion(versionMetadata: unknown): string | null {
    const metadata = v.safeParse(versionMetadataSchema, versionMetadata);
    return metadata.success ? metadata.output.id : null;
}
