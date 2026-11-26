import { useEffect } from "react";
import { useToast } from "./toast.tsx";

/** Shows a success toast once each time `title` becomes a new message, so a view can announce what its state says. */
export function ToastAnnouncement({
    title,
    description,
}: {
    readonly title: string | null;
    readonly description?: string | undefined;
}) {
    const showToast = useToast();
    useEffect(() => {
        if (title !== null) {
            showToast({ title, description, variant: "success" });
        }
    }, [title, description, showToast]);
    return null;
}
