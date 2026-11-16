import { existsSync, watch } from "node:fs";
import { join } from "node:path";

/** Settles once the controlled peer has created `name` in `directory`, which it does to say it reached that point. */
export function fileCreated(directory: string, name: string): Promise<void> {
    const created = Promise.withResolvers<void>();
    const watcher = watch(directory, () => {
        if (existsSync(join(directory, name))) {
            watcher.close();
            created.resolve();
        }
    });
    if (existsSync(join(directory, name))) {
        watcher.close();
        created.resolve();
    }
    return created.promise;
}
