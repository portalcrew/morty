import { CirclePlay } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/cloud-button.tsx";
import { Dialog } from "../ui/dialog.tsx";

export function SetupDemoVideo({ poster, video }: { readonly poster: string; readonly video: string }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                className="-mr-3 ml-3 max-w-full px-3 py-1 text-right font-normal"
                onClick={() => setOpen(true)}
                size="sm"
                variant="ghost"
            >
                <CirclePlay aria-hidden="true" />
                <span>Watch demo</span>
            </Button>
            {open && (
                <Dialog onClose={() => setOpen(false)} size="wide" title="Morty in one minute">
                    {/* Nothing loads until a visitor opens the demo, so the setup page stays as light as before. */}
                    <video
                        aria-label="Morty demo"
                        autoPlay
                        className="aspect-video w-full rounded-[16px]"
                        controls
                        playsInline
                        poster={poster}
                        src={video}
                    >
                        <track kind="captions" label="English" src="/morty-demo.en.vtt" srcLang="en" />
                    </video>
                </Dialog>
            )}
        </>
    );
}
