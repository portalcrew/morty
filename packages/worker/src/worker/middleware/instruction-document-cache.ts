import * as v from "valibot";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import {
    instructionDocumentPaths,
    instructionOrigin,
} from "../components/instruction-documents/service/instruction-document-service.ts";

type WorkerFetch = (request: Request, bindings: CloudBindings, context?: ExecutionContext) => Promise<Response>;

const versionMetadataSchema = v.object({ id: v.pipe(v.string(), v.minLength(1)) });

export function withInstructionDocumentCache(next: WorkerFetch): WorkerFetch {
    return async (request, bindings, context) => {
        const url = new URL(request.url);
        if (request.method !== "GET" || !instructionDocumentPaths.has(url.pathname)) {
            return next(request, bindings, context);
        }
        const origin = instructionOrigin(bindings.APP_ORIGIN === undefined ? url.origin : bindings.APP_ORIGIN);
        // A cached copy outlives the deployment that rendered it, and each data center keeps its own. Keying it by
        // the deployed version means a new deployment never serves an earlier version's document.
        const version = v.safeParse(versionMetadataSchema, bindings.CF_VERSION_METADATA);
        if (origin === null || !version.success) {
            return next(request, bindings, context);
        }
        url.search = "";
        url.searchParams.set("origin", origin);
        url.searchParams.set("version", version.output.id);
        const cacheKey = new Request(url, { method: "GET" });
        const cache = await caches.open("instruction-documents");
        const cached = await cache.match(cacheKey);
        if (cached) {
            const response = new Response(cached.body, cached);
            response.headers.set("X-Instruction-Cache", "HIT");
            return response;
        }
        const response = await next(request, bindings, context);
        if (response.status === 200) {
            await cache.put(cacheKey, response.clone());
            response.headers.set("X-Instruction-Cache", "MISS");
        }
        return response;
    };
}
