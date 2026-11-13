import { Hono } from "hono";
import * as v from "valibot";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { RequestError } from "../../http/request-error.ts";

const assetBindingSchema = v.custom<Fetcher>(
    (value) => typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function",
);

// Fallback for direct Worker callers; deployed browser navigations use the assets SPA router.
const paths = ["/setup", "/chat", "/continue"].flatMap((path) => [path, `${path}/`]);

export const webPages = new Hono<{ readonly Bindings: CloudBindings }>().on("GET", paths, async (context) => {
    const assets = v.safeParse(assetBindingSchema, context.env.ASSETS);
    if (!assets.success) {
        throw new RequestError("WEB_ASSETS_UNAVAILABLE", "The application page is unavailable.", 503);
    }
    const request = context.req.raw;
    const response = await assets.output.fetch(
        new Request(new URL("/", request.url), {
            method: request.method,
            headers: request.headers,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        }),
    );
    const page = new Response(response.body, response);
    page.headers.set("X-Robots-Tag", "noindex");
    return page;
});

// Self-contained so it renders without the application bundle; it never echoes the request URL.
const notFoundDocument = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#18181b" />
    <meta name="robots" content="noindex" />
    <title>Page not found · Morty</title>
    <link rel="icon" href="/favicon.ico?v=2" sizes="16x16 32x32 48x48" />
    <style>
      @font-face { font-family: "Inter"; font-weight: 400; font-display: swap; src: url("/fonts/Inter-Regular.ttf") format("truetype"); }
      @font-face { font-family: "Inter"; font-weight: 600; font-display: swap; src: url("/fonts/Inter-SemiBold.ttf") format("truetype"); }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; color: #0e0f11; background: radial-gradient(circle at top, #f6f7f9 0%, #f0f1f4 48%); font-family: Inter, ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
      a { color: inherit; }
      a:focus-visible { outline: 2px solid #4f7cff; outline-offset: 3px; }
      header { width: 100%; max-width: 1104px; margin: 0 auto; padding: 14px 24px; }
      .brand { display: inline-flex; align-items: center; gap: 12px; font-weight: 600; text-decoration: none; border-radius: 8px; }
      .mark { display: block; width: 36px; height: 36px; }
      main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 48px 24px; }
      section { width: 100%; max-width: 460px; padding: 40px 32px 32px; text-align: center; border: 1px solid #fff; border-radius: 20px; background: rgba(250, 250, 251, 0.9); box-shadow: 0 8px 32px rgba(11, 26, 57, 0.06); }
      .code { margin: 0 0 8px; color: #828a99; font-size: 14px; font-weight: 600; letter-spacing: 0.08em; }
      h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.03em; }
      p { margin: 12px 0 0; color: #454959; font-size: 15px; }
      .home { display: flex; min-height: 48px; margin-top: 24px; align-items: center; justify-content: center; border-radius: 24px; background: #4f7cff; color: #0e0f11; font-weight: 600; text-decoration: none; }
      .home:hover { background: #6e97ff; }
      .home:active { background: #3154d2; }
    </style>
  </head>
  <body>
    <header>
      <a class="brand" href="/" aria-label="Morty home"><img class="mark" src="/morty-logo.svg" alt="" width="36" height="36">Morty</a>
    </header>
    <main>
      <section>
        <p class="code">404</p>
        <h1>Page not found</h1>
        <p>This address doesn't exist on Morty. Check the link, or start again from the home page.</p>
        <a class="home" href="/">Go to Morty home</a>
      </section>
    </main>
  </body>
</html>
`;

/** A browser opening a missing public page gets HTML; API calls and agent fetches keep the structured JSON 404. */
function isPageNavigation(request: Request): boolean {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return false;
    }
    if (new URL(request.url).pathname.startsWith("/morty/")) {
        return false;
    }
    // Fetch Metadata: page loads are "document"; fetch() and subresource requests use other destinations.
    const destination = request.headers.get("Sec-Fetch-Dest");
    if (destination !== null) {
        return destination === "document";
    }
    // Browsers without Fetch Metadata still ask for HTML when opening a page.
    return request.headers.get("Accept")?.includes("text/html") ?? false;
}

export function notFoundPage(request: Request): Response | null {
    if (!isPageNavigation(request)) {
        return null;
    }
    return new Response(request.method === "HEAD" ? null : notFoundDocument, {
        status: 404,
        headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/html; charset=utf-8",
            Vary: "Accept, Sec-Fetch-Dest",
            "X-Robots-Tag": "noindex",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "X-Frame-Options": "DENY",
            // Preview srcdoc documents have their own resource policy. Keep it usable under the page policy.
            "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'",
        },
    });
}
