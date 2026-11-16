export type DisclosureChoice = "collapsed" | "expanded" | "unset";

export function disclosureOpen(choice: DisclosureChoice, defaultOpen: boolean): boolean {
    return choice === "expanded" || (choice === "unset" && defaultOpen);
}
