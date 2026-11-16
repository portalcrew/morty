import { DOWNLOAD_MEDIA_TYPE } from "../../components/images/file-source.ts";

export interface LocalFileDownload {
    readonly blob: Blob;
    readonly name: string;
}

function safeDownloadName(value: string): string {
    const name = value.split(/[\\/]/u).at(-1)?.trim() ?? "";
    return name.length > 0 ? name : "download";
}

/** Saves the bytes under their name. They are never rendered, even where a browser ignores the download attribute. */
export function downloadLocalFile(file: LocalFileDownload): void {
    // Retyping a Blob references its data rather than copying it, which matters for large files.
    const url = URL.createObjectURL(new Blob([file.blob], { type: DOWNLOAD_MEDIA_TYPE }));
    try {
        const link = document.createElement("a");
        link.download = safeDownloadName(file.name);
        link.href = url;
        link.hidden = true;
        document.body.appendChild(link);
        try {
            link.click();
        } finally {
            link.remove();
        }
    } finally {
        URL.revokeObjectURL(url);
    }
}
