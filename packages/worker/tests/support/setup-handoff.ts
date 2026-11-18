import {
    openSetupHandoff,
    readSetupHandoffLink,
    type SetupHandoff,
    setupHandoffLookupId,
} from "@portalcrew/morty-client";
import * as v from "valibot";

/** What a browser reads from a setup link: the sealed contents the Relay holds for it, opened with the link's key. */
export async function openedSetupHandoff(
    url: string,
    dispatch: (request: Request) => Promise<Response>,
): Promise<SetupHandoff> {
    const address = new URL(url);
    const link = readSetupHandoffLink(address.hash);
    if (link === null) {
        throw new Error(`Expected a sealed setup link: ${url}`);
    }
    const response = await dispatch(
        new Request(
            new URL(
                `/morty/api/v1/computers/${link.computerId}/identity/setup-handoffs/${await setupHandoffLookupId(link)}`,
                address.origin,
            ),
        ),
    );
    if (response.status !== 200) {
        throw new Error(`The setup link's contents are unavailable (${response.status})`);
    }
    return await openSetupHandoff(link, v.parse(v.object({ sealed: v.string() }), await response.json()).sealed);
}
