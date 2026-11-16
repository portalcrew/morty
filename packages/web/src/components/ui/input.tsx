const inputBaseClassName =
    "w-full min-w-0 rounded-full border border-border bg-background text-foreground outline-none transition-[background-color] duration-150 motion-reduce:transition-none enabled:not-focus:hover:bg-accent focus:border-ring focus:outline-none! focus:shadow-[var(--focus-ring-shadow)] disabled:cursor-not-allowed disabled:border-border disabled:bg-morty-fill-opacity-2 disabled:text-morty-text-3 [type=number]:[-moz-appearance:textfield] [type=number]:[&::-webkit-inner-spin-button]:appearance-none [type=number]:[&::-webkit-outer-spin-button]:appearance-none";

export const inputClassName = `${inputBaseClassName} h-9 px-4 text-[13px]`;
