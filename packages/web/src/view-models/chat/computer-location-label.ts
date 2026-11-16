export function computerLocationLabel(computerId: string): string {
    switch (computerId.split("_", 3)[1]) {
        case "wn":
            return "Western North America";
        case "an":
            return "Northeast Asia";
        case "as":
            return "Southeast Asia";
        default:
            return "Asia Pacific";
    }
}
