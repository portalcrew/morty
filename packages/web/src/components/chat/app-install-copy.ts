import { Download, type LucideIcon, SquarePlus } from "lucide-react";

interface AppInstallCopy {
    readonly icon: LucideIcon;
    readonly entry: string;
    readonly title: string;
    readonly detail: string;
    readonly action: string;
}

/** iOS people know adding to the Home Screen, not installing; elsewhere the browser itself says Install. */
export function appInstallCopy(homeScreen: boolean): AppInstallCopy {
    return homeScreen
        ? {
              icon: SquarePlus,
              entry: "Add to Home Screen",
              title: "Add Morty to your Home Screen",
              detail: "Open Morty from your Home Screen, like any other app.",
              action: "Add",
          }
        : {
              icon: Download,
              entry: "Install app",
              title: "Install the Morty app",
              detail: "Open Morty from your home screen or dock, like any other app.",
              action: "Install",
          };
}
