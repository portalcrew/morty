import {
    openSealedHandoff,
    readSealedHandoffLink,
    type SealedHandoff,
    type SetupHandoff,
    sealedHandoffLookupId,
} from "@portalcrew/morty-client";
import * as v from "valibot";

/** What a browser reads from a sealed link: the contents the Relay holds for it, opened with the link's key. */
async function openedSealedHandoff(
    url: string,
    dispatch: (request: Request) => Promise<Response>,
): Promise<SealedHandoff> {
    const address = new URL(url);
    const link = readSealedHandoffLink(address.hash);
    if (link === null) {
        throw new Error(`Expected a sealed link: ${url}`);
    }
    const response = await dispatch(
        new Request(
            new URL(
                `/morty/api/v1/computers/${link.computerId}/identity/setup-handoffs/${await sealedHandoffLookupId(link)}`,
                address.origin,
            ),
        ),
    );
    if (response.status !== 200) {
        throw new Error(`The sealed link's contents are unavailable (${response.status})`);
    }
    return await openSealedHandoff(link, v.parse(v.object({ sealed: v.string() }), await response.json()).sealed);
}

export async function openedSetupHandoff(
    url: string,
    dispatch: (request: Request) => Promise<Response>,
): Promise<SetupHandoff> {
    const opened = await openedSealedHandoff(url, dispatch);
    if (opened.kind !== "setup") {
        throw new Error(`Expected a sealed setup link: ${url}`);
    }
    return opened.handoff;
}

/** The transfer code a shared link hands over, from its contents on the Relay. */
export async function sharedLinkCode(url: string, dispatch: (request: Request) => Promise<Response>): Promise<string> {
    const opened = await openedSealedHandoff(url, dispatch);
    if (opened.kind !== "access") {
        throw new Error(`Expected a sealed shared link: ${url}`);
    }
    return opened.handoff.code;
}
