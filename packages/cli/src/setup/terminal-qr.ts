import QRCode from "qrcode";

// A standard terminal: a wider code would wrap in it and stop scanning.
const maximumColumns = 80;

/**
 * Draws the QR code with half-block characters for the terminal that runs setup. Blocks are the light modules, so the
 * code scans on the dark background most terminals use even where colors are stripped, and explicit white-on-black
 * keeps it scannable on a light background wherever colors survive. The four-module quiet zone is the minimum the QR
 * specification requires around the code.
 */
export async function terminalQrCode(
    value: string,
    terminal: { readonly columns: number | undefined; readonly color: boolean },
): Promise<string | null> {
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
    if (width === 0 || width > Math.min(maximumColumns, terminal.columns ?? maximumColumns)) {
        return null;
    }
    const lines = terminal.color ? drawn.map((line) => `\x1b[97;40m${line}\x1b[0m`) : drawn;
    return `${lines.join("\n")}\n`;
}
