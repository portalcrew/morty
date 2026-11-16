function isAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function stopProcess(pid) {
    if (!isAlive(pid)) {
        return;
    }
    const signal = (name) => {
        try {
            process.kill(-pid, name);
        } catch {
            try {
                process.kill(pid, name);
            } catch {}
        }
    };
    signal("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (isAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (isAlive(pid)) {
        signal("SIGKILL");
    }
}

module.exports = { stopProcess };
