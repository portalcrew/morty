import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

const mobileComposerQuery = "(max-width: 639px)";

/** Keep a restored textarea focus visible before the first mobile paint. */
export function useMobileComposerActive(textarea: RefObject<HTMLTextAreaElement | null>) {
    const [mobile, setMobile] = useState(() => window.matchMedia(mobileComposerQuery).matches);
    const [active, setActive] = useState(true);

    useEffect(() => {
        const query = window.matchMedia(mobileComposerQuery);
        const update = () => setMobile(query.matches);
        query.addEventListener("change", update);
        update();
        return () => query.removeEventListener("change", update);
    }, []);

    useLayoutEffect(() => {
        if (mobile && document.activeElement !== textarea.current) {
            setActive(false);
        }
    }, [mobile, textarea]);

    const activate = () => {
        textarea.current?.focus({ preventScroll: true });
        setActive(true);
    };

    return { active, activate, mobile, setActive };
}
