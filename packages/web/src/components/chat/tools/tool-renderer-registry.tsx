import type { ComponentType, ReactNode } from "react";
import { BrowserJavascriptToolCall, matchesBrowserJavascriptToolCall } from "./browser-javascript-tool-call.tsx";
import { ChangedFilesEditToolCall, matchesChangedFilesEditToolCall } from "./changed-files-edit-tool-call.tsx";
import { CwdShellCommandToolCall, matchesCwdShellCommandToolCall } from "./cwd-shell-command-tool-call.tsx";
import { FilePathEditToolCall, matchesFilePathEditToolCall } from "./file-path-edit-tool-call.tsx";
import { FilePathReadToolCall, matchesFilePathReadToolCall } from "./file-path-read-tool-call.tsx";
import { GlobToolCall, matchesGlobToolCall } from "./glob-tool-call.tsx";
import { GrepToolCall, matchesGrepToolCall } from "./grep-tool-call.tsx";
import { ImageGenerationToolCall, matchesImageGenerationToolCall } from "./image-generation-tool-call.tsx";
import { InputDiffEditToolCall, matchesInputDiffEditToolCall } from "./input-diff-edit-tool-call.tsx";
import { matchesOutputDiffEditToolCall, OutputDiffEditToolCall } from "./output-diff-edit-tool-call.tsx";
import { matchesPatchEditToolCall, PatchEditToolCall } from "./patch-edit-tool-call.tsx";
import { matchesPathReadToolCall, PathReadToolCall } from "./path-read-tool-call.tsx";
import { matchesPiFileToolCall, PiFileToolCall } from "./pi-file-tool-call.tsx";
import { matchesQuestionToolCall, QuestionToolCall } from "./question-tool-call.tsx";
import { matchesRichContentEditToolCall, RichContentEditToolCall } from "./rich-content-edit-tool-call.tsx";
import { matchesSkillToolCall, SkillToolCall } from "./skill-tool-call.tsx";
import type { ToolRendererProps, ToolThinkingEntry } from "./tool-renderer.ts";
import { matchesViewImageToolCall, ViewImageToolCall } from "./view-image-tool-call.tsx";
import { matchesWorkdirShellCommandToolCall, WorkdirShellCommandToolCall } from "./workdir-shell-command-tool-call.tsx";

interface ToolRenderer {
    readonly Component: ComponentType<ToolRendererProps>;
    /** Whether the matched call changes workspace files. */
    readonly editsFiles: boolean;
    readonly matches: (entry: ToolThinkingEntry) => boolean;
}

const TOOL_RENDERERS: readonly ToolRenderer[] = [
    {
        Component: QuestionToolCall,
        editsFiles: false,
        matches: matchesQuestionToolCall,
    },
    {
        Component: SkillToolCall,
        editsFiles: false,
        matches: matchesSkillToolCall,
    },
    {
        Component: ImageGenerationToolCall,
        editsFiles: false,
        matches: matchesImageGenerationToolCall,
    },
    {
        Component: ViewImageToolCall,
        editsFiles: false,
        matches: matchesViewImageToolCall,
    },
    {
        Component: ChangedFilesEditToolCall,
        editsFiles: true,
        matches: matchesChangedFilesEditToolCall,
    },
    {
        Component: BrowserJavascriptToolCall,
        editsFiles: false,
        matches: matchesBrowserJavascriptToolCall,
    },
    {
        Component: PiFileToolCall,
        editsFiles: true,
        matches: matchesPiFileToolCall,
    },
    {
        Component: FilePathEditToolCall,
        editsFiles: true,
        matches: matchesFilePathEditToolCall,
    },
    {
        Component: InputDiffEditToolCall,
        editsFiles: true,
        matches: matchesInputDiffEditToolCall,
    },
    {
        Component: OutputDiffEditToolCall,
        editsFiles: true,
        matches: matchesOutputDiffEditToolCall,
    },
    {
        Component: PatchEditToolCall,
        editsFiles: true,
        matches: matchesPatchEditToolCall,
    },
    {
        Component: RichContentEditToolCall,
        editsFiles: true,
        matches: matchesRichContentEditToolCall,
    },
    {
        Component: CwdShellCommandToolCall,
        editsFiles: false,
        matches: matchesCwdShellCommandToolCall,
    },
    {
        Component: WorkdirShellCommandToolCall,
        editsFiles: false,
        matches: matchesWorkdirShellCommandToolCall,
    },
    {
        Component: PathReadToolCall,
        editsFiles: false,
        matches: matchesPathReadToolCall,
    },
    {
        Component: FilePathReadToolCall,
        editsFiles: false,
        matches: matchesFilePathReadToolCall,
    },
    {
        Component: GrepToolCall,
        editsFiles: false,
        matches: matchesGrepToolCall,
    },
    {
        Component: GlobToolCall,
        editsFiles: false,
        matches: matchesGlobToolCall,
    },
];

function registeredRenderer(entry: ToolThinkingEntry): ToolRenderer | undefined {
    return TOOL_RENDERERS.find((candidate) => candidate.matches(entry));
}

export function isFileEditToolCall(entry: ToolThinkingEntry): boolean {
    return registeredRenderer(entry)?.editsFiles === true;
}

export function renderRegisteredTool(entry: ToolThinkingEntry): ReactNode | null {
    const renderer = registeredRenderer(entry);
    if (renderer === undefined) {
        return null;
    }
    const Component = renderer.Component;
    return <Component entry={entry} />;
}
