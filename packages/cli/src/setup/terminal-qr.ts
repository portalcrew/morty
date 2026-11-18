import QRCode from "qrcode";

// An Agent that captures setup's output hides the terminal's width, so setup assumes a standard terminal there.
const assumedColumns = 80;

const expandHint = "↑ Scan to open Morty. If this output is folded, expand it to see the QR code.";

/**
 * Draws the QR code with half-block characters for the terminal that runs setup. Blocks are the light modules, so the
 * code scans on the dark background most terminals use even where colors are stripped, and explicit white-on-black
 * keeps it scannable on a light background wherever colors survive. The four-module quiet zone is the minimum the QR
 * specification requires around the code.
 */
export async function terminalQrCode(
    value: string,
    terminal: { readonly columns: number | undefined; readonly color: boolean },
): Promise<string> {
    // A link too long for any QR code has none; the link itself still opens Morty.
    const drawn = await QRCode.toString(value, {
        type: "utf8",
        errorCorrectionLevel: "M",
        margin: 4,
        color: { dark: "#ffffff", light: "#000000" },
    }).then(
        (text) => text.split("\n"),
        () => [],
    );
    const width = drawn[0]?.length ?? 0;
    // A code wider than the terminal wraps and stops scanning, so the reader is pointed at what still works.
    if (width === 0 || width > (terminal.columns ?? assumedColumns)) {
        return "No QR code fits this terminal. Open the link or the QR image that setup returned.\n";
    }
    const lines = terminal.color ? drawn.map((line) => `\x1b[97;40m${line}\x1b[0m`) : drawn;
    // Agents fold command output and keep only its last lines visible, so the way to the code comes last.
    return `${lines.join("\n")}\n${expandHint}\n`;
}
