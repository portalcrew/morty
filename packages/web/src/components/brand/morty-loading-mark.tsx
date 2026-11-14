import { useId } from "react";

const petals = [
    {
        delay: "357ms",
        id: "tl",
        origin: "52.2455% 42.2467%",
        path: "M187.248 121.795C187.248 138.151 173.99 151.409 157.634 151.409L53.4678 151.409C33.5476 151.409 16.2642 137.66 11.7845 118.25L11.3988 116.578C7.10668 97.9791 11.2389 78.4338 22.6916 63.1635L22.7365 63.1036C44.6106 33.9538 75.6227 13.0836 110.858 3.77606L118.129 1.85546C153.052 -7.36955 187.248 18.9663 187.248 55.0874L187.248 121.795Z",
    },
    {
        delay: "0ms",
        id: "tr",
        origin: "57.7536% 42.2467%",
        path: "M206.991 57.1837C206.991 51.9798 211.209 47.7612 216.413 47.7612L216.832 47.7612C268.871 47.7612 310.639 89.9475 310.639 141.987L310.639 142.004C310.639 147.208 306.42 151.41 301.217 151.41L235.259 151.41C219.647 151.41 206.991 138.754 206.991 123.142L206.991 57.1837Z",
    },
    {
        delay: "161ms",
        id: "br",
        origin: "57.7536% 47.7545%",
        path: "M236.605 171.152C220.249 171.152 206.991 184.411 206.991 200.766L206.991 304.932C206.991 324.853 220.74 342.136 240.15 346.616L241.822 347.001C260.421 351.294 279.966 347.161 295.237 335.709L295.296 335.664C324.446 313.79 345.316 282.778 354.624 247.542L356.544 240.271C365.77 205.348 339.434 171.152 303.313 171.152L236.605 171.152Z",
    },
    {
        delay: "259ms",
        id: "bl",
        origin: "52.2455% 47.7545%",
        path: "M30.7668 171.152C10.2843 171.152 -4.47231 190.802 1.23844 210.472L1.27794 210.608C21.831 281.397 76.9999 336.579 147.792 357.122L147.928 357.162C167.598 362.872 187.248 348.116 187.248 327.633L187.248 200.766C187.248 184.411 173.99 171.152 157.634 171.152L30.7668 171.152Z",
    },
] as const;

/** The whole-document loading mark: every petal scales in clockwise sequence. */
export function MortyLoadingMark() {
    const clipPrefix = useId().replaceAll(":", "");

    return (
        <span aria-hidden="true" className="relative grid size-17 shrink-0 place-items-center">
            <svg aria-hidden="true" className="absolute size-0 overflow-hidden" focusable="false">
                <defs>
                    {petals.map((petal) => (
                        <clipPath clipPathUnits="userSpaceOnUse" id={`${clipPrefix}-${petal.id}`} key={petal.id}>
                            <path d={petal.path} transform="translate(247.667 170.091)" />
                        </clipPath>
                    ))}
                </defs>
                <image
                    height="358.4"
                    href="/morty-logo.svg"
                    id={`${clipPrefix}-art`}
                    width="358.4"
                    x="247.667"
                    y="170.091"
                />
            </svg>
            <span className="relative size-12">
                {petals.map((petal) => (
                    <svg
                        aria-hidden="true"
                        className="absolute inset-0 size-full animate-morty-loading-petal overflow-visible [transform-box:view-box] motion-reduce:animate-none"
                        data-loading-petal=""
                        key={petal.id}
                        style={{ animationDelay: petal.delay, transformOrigin: petal.origin }}
                        viewBox="247.667 170.091 358.4 358.4"
                    >
                        <use clipPath={`url(#${clipPrefix}-${petal.id})`} href={`#${clipPrefix}-art`} />
                    </svg>
                ))}
            </span>
        </span>
    );
}
