/** Audio is played only from these types; anything else is offered as a download link. */
export const isSafeAudioType = (mediaType: string): boolean =>
    /^audio\/(?:aac|mpeg|mp4|ogg|wav|webm)$/u.test(mediaType);
