import QRCode from "qrcode";

export type SetupQrMode = "auto" | "terminal" | "image";

interface SetupOutput {
    readonly write: (value: string) => unknown;
    readonly isTTY?: boolean;
    readonly columns?: number;
}

export function createSetupReporter(options: {
    readonly stdout: SetupOutput;
    readonly stderr: SetupOutput;
    readonly qr: SetupQrMode;
    readonly noColor: boolean;
}): (event: Readonly<Record<string, unknown>>) => void {
    return (event) => {
        options.stdout.write(`${JSON.stringify(event)}\n`);
        if (
            event["status"] !== "ready" ||
            typeof event["url"] !== "string" ||
            options.qr === "image" ||
            (options.qr === "auto" && !options.stderr.isTTY)
        ) {
            return;
        }
        const output = terminalQr(event["url"], options.stderr.columns, !!options.stderr.isTTY && !options.noColor);
        options.stderr.write(output);
    };
}

function terminalQr(url: string, columns: number | undefined, color: boolean): string {
    let modules: ReturnType<typeof QRCode.create>["modules"];
    try {
        modules = QRCode.create(url, { errorCorrectionLevel: "M" }).modules;
    } catch {
        return "Terminal QR unavailable. Use the handoff link returned above.\n";
    }
    // The library's small terminal renderer fixes the quiet zone at one module; scanners need four.
    const margin = 4;
    const width = modules.size + margin * 2;
    if (columns !== undefined && columns > 0 && width >= columns) {
        return `Terminal too narrow for this QR (${width + 1} columns needed). Use the PNG or link returned above.\n`;
    }
    const dark = (x: number, y: number): boolean =>
        x >= margin &&
        y >= margin &&
        x < width - margin &&
        y < width - margin &&
        modules.get(y - margin, x - margin) === 1;
    const lines = [
        `Scan to open Morty within 10 minutes (${width + 1} columns needed; expand command output if hidden).`,
    ];
    for (let y = 0; y < width; y += 2) {
        let line = color ? "\x1b[30;47m" : "";
        for (let x = 0; x < width; x++) {
            const top = dark(x, y);
            const bottom = dark(x, y + 1);
            line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
        }
        lines.push(line + (color ? "\x1b[0m" : ""));
    }
    lines.push("If the code wraps or is clipped, use the PNG or link returned above.", "");
    return lines.join("\n");
}
