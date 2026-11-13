module.exports = {
    forbidden: [
        {
            name: "storage-does-not-depend-on-upper-layers",
            severity: "error",
            from: {
                path: [
                    "^packages/worker/src/(?:(?:worker|computer-relay)/)?(schema|storage|entity|infra)/",
                    "^packages/worker/src/(?:worker|computer-relay)/components/[^/]+/(schema|storage|entity|infra)/",
                ],
            },
            to: {
                reachable: true,
                path: [
                    "^packages/worker/src/(?:(?:worker|computer-relay)/)?(service|http|route|composition|gateway)/",
                    "^packages/worker/src/(?:worker|computer-relay)/components/[^/]+/(service|http|route|composition|gateway)/",
                ],
            },
        },
        {
            name: "routes-use-services-not-storage",
            severity: "error",
            comment:
                "Routes translate requests and call services; persistence belongs to storage behind a service (route -> service -> storage).",
            from: {
                path: [
                    "^packages/worker/src/(?:worker|computer-relay)/components/[^/]+/(http|route)/",
                    "^packages/worker/src/(?:worker|computer-relay)/(http|route)/",
                ],
            },
            to: {
                path: [
                    "^packages/worker/src/(?:worker|computer-relay)/storage/",
                    "^packages/worker/src/(?:worker|computer-relay)/components/[^/]+/storage/",
                ],
                dependencyTypesNot: ["type-only"],
            },
        },
        {
            name: "worker-does-not-import-computer-relay",
            severity: "error",
            from: { path: "^packages/worker/src/worker/" },
            to: { path: "^packages/worker/src/computer-relay/" },
        },
        {
            name: "computer-relay-does-not-import-worker-implementation",
            severity: "error",
            from: { path: "^packages/worker/src/computer-relay/" },
            to: { path: "^packages/worker/src/worker/" },
        },
        {
            name: "shared-boundaries-do-not-import-service-implementations",
            severity: "error",
            from: { path: "^packages/worker/src/contracts/" },
            to: { path: "^packages/worker/src/(worker|computer-relay)/" },
        },
        {
            name: "browser-does-not-import-worker-implementation",
            severity: "error",
            from: { path: "^packages/web/src/" },
            to: { path: "^packages/worker/" },
        },
        {
            name: "worker-does-not-import-browser-implementation",
            severity: "error",
            from: { path: "^packages/worker/src/" },
            to: {
                path: "^packages/web/",
                // Public instruction text is served by the Worker, without browser code.
                pathNot: "^packages/web/content/instructions/[^/]+\\.txt$",
            },
        },
        {
            name: "session-pane-contracts-do-not-import-the-pane",
            severity: "error",
            comment:
                "The Session pane composes its contracts; a contract importing the pane would make the pane a dependency of its own parts.",
            from: {
                path: "^packages/web/src/view-models/chat/session-(connection|interaction-store|lifecycle|settings-store)\\.ts$",
            },
            to: { path: "^packages/web/src/view-models/chat/session-pane-store\\.ts$" },
        },
        {
            name: "session-pane-contracts-are-independent",
            severity: "error",
            comment:
                "Connection, interactions and settings each own one part of the Session's state; the pane coordinates them.",
            from: {
                path: "^packages/web/src/view-models/chat/session-(connection|interaction-store|settings-store)\\.ts$",
            },
            to: {
                path: "^packages/web/src/view-models/chat/session-(connection|interaction-store|settings-store)\\.ts$",
            },
        },
        {
            name: "web-utils-do-not-import-business-layers",
            severity: "error",
            comment: "DOM utilities stay business-agnostic: they may not import views, view-models, or services.",
            from: { path: "^packages/web/src/components/utils/" },
            to: {
                path: ["^packages/web/src/views/", "^packages/web/src/view-models/", "^packages/web/src/services/"],
            },
        },
        {
            name: "web-components-do-not-import-business-layers",
            severity: "error",
            comment:
                "Components may use React hooks but stay business-decoupled: they may not import views, view-models, or services. Business-coupled UI belongs in views.",
            from: { path: "^packages/web/src/components/" },
            to: {
                path: ["^packages/web/src/views/", "^packages/web/src/view-models/", "^packages/web/src/services/"],
                // Type-only imports carry no runtime coupling; components may
                // render against view-model contracts passed in as props.
                dependencyTypesNot: ["type-only"],
            },
        },
        {
            name: "web-stores-live-in-view-models",
            severity: "error",
            comment:
                "Zustand stores belong to the view-model layer (packages/web/AGENTS.md). Elsewhere a store may only be received and typed, never created.",
            from: { path: "^packages/web/src/", pathNot: "^packages/web/src/view-models/" },
            to: { path: "/node_modules/zustand/esm/vanilla", dependencyTypesNot: ["type-only"] },
        },
    ],
    options: {
        doNotFollow: { path: "node_modules" },
        tsPreCompilationDeps: true,
        enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
    },
};
