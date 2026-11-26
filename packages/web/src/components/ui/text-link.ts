/**
 * Inline text link styling. At rest a link is identified by color alone, so the
 * primary color keeps 4.5:1 against the background and 3:1 against body text;
 * resting underlines would break the line rhythm of link-heavy prose and the
 * readability of command-like text in a sentence. Hover adds an underline so
 * the link is not distinguished by color alone (WCAG 1.4.1, technique G183).
 */
export const textLinkClassName =
    "text-primary transition-colors duration-150 motion-reduce:transition-none hover:text-primary-hover hover:underline active:text-primary-active";

export const mutedTextLinkClassName =
    "text-copy-secondary transition-colors duration-150 motion-reduce:transition-none hover:text-foreground active:text-foreground";
