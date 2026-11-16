import { CircleAlert } from "lucide-react";
import { Spinner } from "../ui/spinner.tsx";

export function MessageDeliveryStatus({
    delivery,
    label,
    "data-testid": testId,
}: {
    readonly delivery: "sending" | "failed";
    readonly label: string;
    readonly "data-testid"?: string | undefined;
}) {
    switch (delivery) {
        case "sending":
            // Most sends finish quickly; the spinner fades in only once the wait is noticeable.
            return (
                <span className="flex motion-safe:animate-delayed-reveal" data-testid={testId}>
                    <Spinner label={label} />
                </span>
            );
        case "failed":
            return (
                <span aria-label={label} className="flex text-destructive" data-testid={testId} role="img">
                    <CircleAlert aria-hidden="true" className="size-4" />
                </span>
            );
        default:
            return delivery satisfies never;
    }
}
