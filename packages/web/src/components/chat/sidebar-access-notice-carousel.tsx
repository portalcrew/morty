import {
    Children,
    cloneElement,
    isValidElement,
    type PointerEvent,
    type ReactElement,
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { cn } from "../../lib/utils.ts";
import { useContainsRenderedSection } from "../utils/use-contains-rendered-section.ts";

const autoAdvanceIntervalMs = 6000;
const swipeSlopPx = 10;
const swipeThresholdPx = 40;

type NoticeSwipe = {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly startX: number;
    readonly startY: number;
    axis: "pending" | "horizontal" | "vertical";
};

const carouselTrackClassName =
    "flex w-full min-w-0 items-stretch transition-transform duration-300 ease-out motion-reduce:transition-none";
const carouselSlideShellClassName =
    "box-border w-full min-w-0 shrink-0 grow-0 basis-full self-stretch overflow-visible [&>section]:box-border [&>section]:flex [&>section]:h-full [&>section]:min-h-full [&>section]:flex-col";

/**
 * Shows one access-notice card at a time and slides horizontally to the next.
 * The track is not clipped to the card: that cut the card's own left and right edges.
 * On desktop the clip is the sidebar's outer edge, so a sliding card stays inside the
 * sidebar. Slides outside the moving pair stay hidden so they do not sit beside the card.
 * A horizontal drag anywhere on the card switches notices: left shows the next one,
 * right shows the previous one. Vertical movement scrolls the card, then the sidebar.
 */
export function SidebarAccessNoticeCarousel({ children }: { readonly children: ReactNode }) {
    const slides = Children.toArray(children).filter(
        (child): child is ReactElement => isValidElement(child) && child.type !== null,
    );
    const [step, setStep] = useState(0);
    const [fromStep, setFromStep] = useState(0);
    const [transitionEnabled, setTransitionEnabled] = useState(true);
    const [paused, setPaused] = useState(false);
    const trackRef = useRef<HTMLDivElement>(null);
    const swipeRef = useRef<NoticeSwipe | null>(null);
    const suppressClickRef = useRef(false);
    const retreatFrameRef = useRef(0);

    const loopSlides = useMemo(() => {
        const firstSlide = slides[0];
        // A distinct element. The loop copy must not be the same object as the first card.
        return slides.length > 1 && firstSlide !== undefined
            ? [...slides, cloneElement(firstSlide, { key: "access-notice-loop" })]
            : slides;
    }, [slides]);
    const displayIndex = slides.length === 0 ? 0 : step % slides.length;
    const visibleFrom = Math.min(fromStep, step);
    const visibleTo = Math.max(fromStep, step);
    const dotsReady = useContainsRenderedSection(trackRef);
    const [trackedSlideCount, setTrackedSlideCount] = useState(slides.length);
    if (trackedSlideCount !== slides.length) {
        setTrackedSlideCount(slides.length);
        setStep(0);
        setFromStep(0);
        setTransitionEnabled(true);
    }

    useEffect(() => {
        return () => {
            cancelAnimationFrame(retreatFrameRef.current);
        };
    }, []);

    useEffect(() => {
        if (!transitionEnabled && step === 0) {
            const frame = requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTransitionEnabled(true);
                });
            });
            return () => {
                cancelAnimationFrame(frame);
            };
        }
        return;
    }, [step, transitionEnabled]);

    const moveToStep = (nextStep: number) => {
        setTransitionEnabled(true);
        setFromStep(step);
        setStep(nextStep);
    };

    const advanceForward = useCallback(() => {
        if (slides.length <= 1 || step >= slides.length) {
            return;
        }
        setTransitionEnabled(true);
        setFromStep(step);
        setStep(step + 1);
    }, [slides.length, step]);

    const forwardToDisplayIndex = (targetIndex: number) => {
        const current = step % slides.length;
        const forwardSteps = (targetIndex - current + slides.length) % slides.length;
        if (forwardSteps === 0 || step >= slides.length) {
            return;
        }
        moveToStep(step + forwardSteps);
    };

    const retreatBackward = () => {
        if (slides.length <= 1 || step >= slides.length) {
            return;
        }
        if (step > 0) {
            moveToStep(step - 1);
            return;
        }
        // The first card has no slide to its left. Park on the trailing copy of that
        // same card, then animate back onto the last real card.
        const loopStep = slides.length;
        const previousStep = slides.length - 1;
        setTransitionEnabled(false);
        setFromStep(loopStep);
        setStep(loopStep);
        cancelAnimationFrame(retreatFrameRef.current);
        retreatFrameRef.current = requestAnimationFrame(() => {
            retreatFrameRef.current = requestAnimationFrame(() => {
                retreatFrameRef.current = 0;
                setTransitionEnabled(true);
                setFromStep(loopStep);
                setStep(previousStep);
            });
        });
    };

    const endSwipe = (event: PointerEvent<HTMLElement>, commit: boolean) => {
        const swipe = swipeRef.current;
        if (swipe === null || swipe.pointerId !== event.pointerId) {
            return;
        }
        swipeRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        event.currentTarget.style.userSelect = "";
        if (swipe.pointerType !== "mouse") {
            setPaused(false);
        }
        if (swipe.axis === "pending") {
            const dx = event.clientX - swipe.startX;
            const dy = event.clientY - swipe.startY;
            if (Math.abs(dx) >= swipeSlopPx && Math.abs(dx) > Math.abs(dy)) {
                swipe.axis = "horizontal";
            }
        }
        if (!commit || swipe.axis !== "horizontal") {
            return;
        }
        const distance = event.clientX - swipe.startX;
        if (Math.abs(distance) < swipeThresholdPx) {
            return;
        }
        suppressClickRef.current = true;
        if (distance < 0) {
            advanceForward();
            return;
        }
        retreatBackward();
    };

    useEffect(() => {
        if (slides.length <= 1 || paused) {
            return;
        }
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
        }

        let intervalId = 0;
        const advance = () => {
            if (document.visibilityState !== "visible") {
                return;
            }
            advanceForward();
        };
        const restart = () => {
            window.clearInterval(intervalId);
            intervalId = window.setInterval(advance, autoAdvanceIntervalMs);
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                restart();
            } else {
                window.clearInterval(intervalId);
            }
        };

        restart();
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            window.clearInterval(intervalId);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [advanceForward, paused, slides.length]);

    if (slides.length === 0) {
        return null;
    }
    if (slides.length === 1) {
        return slides[0] ?? null;
    }

    return (
        <section
            aria-label="Access notices"
            aria-roledescription="carousel"
            className="w-full min-w-0 touch-pan-y overflow-visible overscroll-x-contain sm:box-border sm:-mx-2.5 sm:w-[calc(100%+20px)] sm:overflow-x-clip sm:px-2.5"
            onBlur={(event) => {
                const related = event.relatedTarget;
                if (!(related instanceof Node) || !event.currentTarget.contains(related)) {
                    setPaused(false);
                }
            }}
            onClickCapture={(event) => {
                if (!suppressClickRef.current) {
                    return;
                }
                suppressClickRef.current = false;
                event.preventDefault();
                event.stopPropagation();
            }}
            onFocus={() => {
                setPaused(true);
            }}
            onMouseEnter={() => {
                setPaused(true);
            }}
            onMouseLeave={() => {
                if (swipeRef.current?.axis === "horizontal") {
                    return;
                }
                setPaused(false);
            }}
            onPointerCancel={(event) => {
                endSwipe(event, false);
            }}
            onPointerDown={(event) => {
                if (event.button !== 0 || slides.length <= 1 || step >= slides.length) {
                    return;
                }
                suppressClickRef.current = false;
                swipeRef.current = {
                    axis: "pending",
                    pointerId: event.pointerId,
                    pointerType: event.pointerType,
                    startX: event.clientX,
                    startY: event.clientY,
                };
            }}
            onPointerLeave={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    return;
                }
                endSwipe(event, true);
            }}
            onPointerMove={(event) => {
                const swipe = swipeRef.current;
                if (swipe === null || swipe.pointerId !== event.pointerId || swipe.axis !== "pending") {
                    return;
                }
                const dx = event.clientX - swipe.startX;
                const dy = event.clientY - swipe.startY;
                if (Math.abs(dx) < swipeSlopPx && Math.abs(dy) < swipeSlopPx) {
                    return;
                }
                if (Math.abs(dy) > Math.abs(dx)) {
                    swipe.axis = "vertical";
                    return;
                }
                swipe.axis = "horizontal";
                event.currentTarget.style.userSelect = "none";
                window.getSelection()?.removeAllRanges();
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.setPointerCapture(event.pointerId);
                }
                if (swipe.pointerType !== "mouse") {
                    setPaused(true);
                }
            }}
            onPointerUp={(event) => {
                endSwipe(event, true);
            }}
        >
            <div
                ref={trackRef}
                className={cn(carouselTrackClassName, !transitionEnabled && "transition-none")}
                onTransitionEnd={(event) => {
                    if (event.target !== event.currentTarget || event.propertyName !== "transform") {
                        return;
                    }
                    if (step === slides.length) {
                        setTransitionEnabled(false);
                        setFromStep(0);
                        setStep(0);
                    } else {
                        setFromStep(step);
                    }
                }}
                style={{
                    transform: `translateX(-${(step * 100).toString()}%)`,
                }}
            >
                {loopSlides.map((slide, slideIndex) => {
                    const shown = slideIndex >= visibleFrom && slideIndex <= visibleTo;
                    return (
                        <div
                            aria-hidden={slideIndex !== step}
                            className={cn(
                                carouselSlideShellClassName,
                                shown ? "visible" : "invisible",
                                slideIndex === step ? null : "pointer-events-none",
                            )}
                            key={
                                slideIndex === slides.length
                                    ? `loop:${slide.key?.toString() ?? slideIndex.toString()}`
                                    : (slide.key ?? slideIndex.toString())
                            }
                        >
                            {slide}
                        </div>
                    );
                })}
            </div>
            {dotsReady ? (
                <div className="flex items-center justify-center gap-0 pt-2 -mb-2 sm:-mb-3">
                    {slides.map((slide, slideIndex) => (
                        <button
                            aria-current={slideIndex === displayIndex ? "true" : undefined}
                            aria-label={`Notice ${(slideIndex + 1).toString()} of ${slides.length.toString()}`}
                            className="inline-flex h-3 w-3 shrink-0 appearance-none items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60"
                            key={slide.key ?? slideIndex.toString()}
                            onClick={() => {
                                forwardToDisplayIndex(slideIndex);
                            }}
                            type="button"
                        >
                            <svg
                                aria-hidden="true"
                                className={cn(
                                    "block h-2 w-2 shrink-0 overflow-visible transition-colors duration-300 ease-out motion-reduce:transition-none",
                                    slideIndex === displayIndex ? "text-foreground/80" : "text-morty-text-3",
                                )}
                                height="8"
                                viewBox="0 0 8 8"
                                width="8"
                            >
                                <circle cx="4" cy="4" fill="currentColor" r="3" />
                            </svg>
                        </button>
                    ))}
                </div>
            ) : null}
        </section>
    );
}
