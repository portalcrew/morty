import { createHighlighterCore, type HighlighterCore, type TokensResult } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";
const MAX_HIGHLIGHTERS = 8;
const MAX_RESULTS = 32;
const MAX_CACHED_SOURCE_CHARACTERS = 512 * 1024;
const MAX_CACHED_TOKENS = 64 * 1024;

interface CachedResult {
    readonly result: TokensResult;
    readonly sourceCharacters: number;
    readonly tokens: number;
}

const highlighters = new Map<string, Promise<HighlighterCore>>();
const results = new Map<string, CachedResult>();
const pending = new Map<string, Set<(result: TokensResult) => void>>();

function languageRegistration(language: string) {
    return Object.entries(bundledLanguages).find(([name]) => name === language)?.[1] ?? null;
}

/**
 * Tokens that carry code no bundled grammar can highlight. Streamdown keeps the
 * last result the plugin delivered for a block, so a `null` answer that no
 * callback ever follows freezes that block at the code it held when it mounted.
 * `null` means a result is still coming; a language we cannot highlight needs
 * unstyled tokens instead, which the theme colors as ordinary code.
 */
function unhighlightedTokens(code: string): TokensResult {
    let offset = 0;
    const tokens = code.split("\n").map((line) => {
        const token = { bgColor: "transparent", color: "inherit", content: line, offset };
        offset += line.length + 1;
        return [token];
    });
    return { bg: "transparent", fg: "inherit", tokens };
}

function resultKey(options: HighlightOptions): string {
    const [lightTheme, darkTheme] = options.themes;
    const themeName = (theme: typeof lightTheme): string =>
        typeof theme === "string" ? theme : (theme.name ?? "custom");
    return `${options.language}\0${themeName(lightTheme)}\0${themeName(darkTheme)}\0${options.code}`;
}

function tokenCount(result: TokensResult): number {
    return result.tokens.reduce((total, line) => total + line.length, 0);
}

function readResult(key: string): TokensResult | null {
    const cached = results.get(key);
    if (cached === undefined) {
        return null;
    }
    results.delete(key);
    results.set(key, cached);
    return cached.result;
}

function removeOldestResult(): void {
    const oldestKey = results.keys().next().value;
    if (oldestKey === undefined) {
        return;
    }
    results.delete(oldestKey);
}

/** What the cached results hold, summed from them: they are the one record of it. */
function cachedTotals(): { readonly sourceCharacters: number; readonly tokens: number } {
    let sourceCharacters = 0;
    let tokens = 0;
    for (const cached of results.values()) {
        sourceCharacters += cached.sourceCharacters;
        tokens += cached.tokens;
    }
    return { sourceCharacters, tokens };
}

function cacheResult(key: string, code: string, result: TokensResult): void {
    const tokens = tokenCount(result);
    if (code.length > MAX_CACHED_SOURCE_CHARACTERS || tokens > MAX_CACHED_TOKENS) {
        return;
    }
    results.delete(key);
    results.set(key, { result, sourceCharacters: code.length, tokens });
    for (
        let held = cachedTotals();
        results.size > MAX_RESULTS ||
        held.sourceCharacters > MAX_CACHED_SOURCE_CHARACTERS ||
        held.tokens > MAX_CACHED_TOKENS;
        held = cachedTotals()
    ) {
        removeOldestResult();
    }
}

function highlighter(language: string): Promise<HighlighterCore> | null {
    const registration = languageRegistration(language);
    if (registration === null) {
        return null;
    }
    const existing = highlighters.get(language);
    if (existing !== undefined) {
        highlighters.delete(language);
        highlighters.set(language, existing);
        return existing;
    }
    const created = createHighlighterCore({
        engine: createJavaScriptRegexEngine({ forgiving: true }),
        langs: [registration],
        themes: [bundledThemes[LIGHT_THEME], bundledThemes[DARK_THEME]],
    });
    highlighters.set(language, created);
    while (highlighters.size > MAX_HIGHLIGHTERS) {
        const oldestLanguage = highlighters.keys().next().value;
        if (oldestLanguage === undefined) {
            break;
        }
        const oldest = highlighters.get(oldestLanguage);
        highlighters.delete(oldestLanguage);
        if (oldest !== undefined) {
            void oldest.then((value) => value.dispose());
        }
    }
    return created;
}

export const boundedCodeHighlighter: CodeHighlighterPlugin = {
    name: "shiki",
    type: "code-highlighter",
    getSupportedLanguages: () => Object.keys(bundledLanguages),
    getThemes: () => [LIGHT_THEME, DARK_THEME],
    supportsLanguage: (language) => languageRegistration(language) !== null,
    highlight: (options, callback) => {
        const key = resultKey(options);
        const cached = readResult(key);
        if (cached !== null) {
            return cached;
        }
        const waiting = pending.get(key);
        if (waiting !== undefined) {
            if (callback !== undefined) {
                waiting.add(callback);
            }
            return null;
        }
        const requestedHighlighter = highlighter(options.language);
        if (requestedHighlighter === null) {
            return unhighlightedTokens(options.code);
        }
        const callbacks = new Set<(result: TokensResult) => void>();
        if (callback !== undefined) {
            callbacks.add(callback);
        }
        pending.set(key, callbacks);
        void requestedHighlighter
            .then((value) =>
                value.codeToTokens(options.code, {
                    lang: options.language,
                    themes: { light: LIGHT_THEME, dark: DARK_THEME },
                }),
            )
            .then((result) => {
                cacheResult(key, options.code, result);
                for (const notify of callbacks) {
                    notify(result);
                }
            })
            .catch((cause: unknown) => console.error("[Morty Code] Failed to highlight code", cause))
            .finally(() => pending.delete(key));
        return null;
    },
};
