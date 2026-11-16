export async function runCleanup(...actions: readonly (() => void | Promise<void>)[]): Promise<void> {
    const [first, ...remaining] = actions;
    if (first === undefined) {
        return;
    }
    try {
        await first();
    } finally {
        await runCleanup(...remaining);
    }
}
