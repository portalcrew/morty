import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import * as v from "valibot";
import { defineConfig } from "vite";
import { bundleLicenses } from "./scripts/bundle-licenses.ts";

const sentry = v.parse(
    v.object({
        VITE_SENTRY_DSN: v.optional(v.string()),
        VITE_SENTRY_RELEASE: v.optional(v.string(), "morty@development"),
    }),
    process.env,
);
const workerConfig = process.env["MORTY_WORKER_CONFIG"];
const revision = process.env["MORTY_RELEASE_REVISION"];
if (revision !== undefined && !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("MORTY_RELEASE_REVISION must be a full commit SHA");
}
for (const name of ["VITE_MORTY_CLI_VERSION", "VITE_MORTY_CLI_VERSION_WEEK_AGO"]) {
    const version = process.env[name];
    if (version !== undefined && !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
        throw new Error(`${name} must be a stable semantic version`);
    }
}
const licenseFile = `assets/THIRD-PARTY-NOTICES-${revision ?? "local"}.txt`;
const assetOrigins =
    process.env["MORTY_ASSET_ORIGIN"] === undefined
        ? undefined
        : {
              application: v.parse(v.pipe(v.string(), v.url()), process.env["MORTY_APP_ORIGIN"]),
              generated: v.parse(v.pipe(v.string(), v.url()), process.env["MORTY_ASSET_ORIGIN"]),
          };

export default defineConfig({
    ...(assetOrigins === undefined
        ? {}
        : {
              experimental: {
                  renderBuiltUrl: (filename: string, { type }: { readonly type: "asset" | "public" }) =>
                      `${type === "public" ? assetOrigins.application : assetOrigins.generated}/${filename}`,
              },
          }),
    plugins: [
        bundleLicenses(licenseFile),
        react(),
        tailwindcss(),
        cloudflare(workerConfig === undefined ? {} : { configPath: workerConfig }),
        ...(sentry.VITE_SENTRY_DSN
            ? sentryVitePlugin({
                  telemetry: false,
                  errorHandler: (error) => {
                      throw error;
                  },
                  // Forks and merge-queue builds need no credentials. Production uploads the exact accepted maps.
                  release: { name: sentry.VITE_SENTRY_RELEASE, create: false, finalize: false },
                  sourcemaps: {
                      disable: "disable-upload",
                  },
              }).map((plugin) => ({
                  ...plugin,
                  applyToEnvironment: (environment: { readonly name: string }) => environment.name === "client",
              }))
            : []),
    ],
    build: {
        sourcemap: "hidden",
        license: { fileName: "bundle-licenses.json" },
        rolldownOptions: {
            output: {
                postBanner: `/* License texts: /${licenseFile} on this asset's origin. */`,
            },
        },
    },
    resolve: {
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./packages/web/src", import.meta.url)) }],
    },
    server: {
        host: "localhost",
        port: 5173,
        strictPort: true,
    },
});
