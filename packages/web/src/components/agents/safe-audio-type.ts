export const isSafeAudioType = (mediaType: string): boolean =>
    /^audio\/(?:aac|mpeg|mp4|ogg|wav|webm)$/u.test(mediaType);
