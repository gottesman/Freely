import React, { useEffect, useCallback, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { useI18n } from './i18n';
import { usePlaybackSelector } from './Playback';
import { useContextMenu, ContextMenuItem } from './ContextMenu';

// --- START: Types for Musixmatch Rich-Sync Lyrics ---

/**
 * Represents a single word or character in a rich-sync lyric line.
 * 'c' is the text content (e.g., a word or space).
 * 'o' is the time offset in seconds from the start of the line.
 */
interface MusixmatchRichSyncPart {
    c: string;
    o: number;
}

/**
 * Represents a single line in a Musixmatch rich-sync response.
 * 'ts' is the start time of the line in seconds.
 * 'te' is the end time of the line in seconds.
 * 'l' is the array of word parts for the line.
 * 'x' is the full text of the line.
 */
interface MusixmatchRichSyncLine {
    ts: number;
    te: number;
    l: MusixmatchRichSyncPart[];
    x: string;
}

/**
 * The structure of the Musixmatch rich-sync API response (an array of lines).
 */
type MusixmatchRichSync = MusixmatchRichSyncLine[];

// --- END: Types for Musixmatch Rich-Sync Lyrics ---

interface PrecomputedWordData {
    isActive: boolean;
}

interface PrecomputedLineData {
    isFocus: boolean;
    isActive: boolean;
    wasActive: boolean;
    isPlayed: boolean;
    isLast: boolean; // Explicit state for the .last class
    peakIdx: number;
    wordData?: PrecomputedWordData[];
}

// The internal, normalized structure that the component's logic uses.
interface InternalLyricsPart {
    text: string;
    start: number; // Absolute start time in seconds
}

interface InternalLyricsLine {
    text: string;
    start: number;
    end: number; // 'end' is now guaranteed to exist from 'te'
    parts?: InternalLyricsPart[];
    isArtificial?: boolean; // Flag for our new interlude lines
}

export interface SyncedLyrics {
    lines: InternalLyricsLine[];
}

export interface LyricsProps {
    lyrics?: string;
    title?: string;
    /**
     * Can accept either the internal SyncedLyrics format or the raw
     * Musixmatch rich-sync format. The component will normalize it.
     */
    synced?: SyncedLyrics | MusixmatchRichSync;
}

interface SyncedLyricsBodyProps {
    lines: InternalLyricsLine[];
    precomputedLinesData: PrecomputedLineData[];
    focusIndex: number;
    activeLineRef: React.RefObject<HTMLDivElement>;
    effectivePosition: number;
    style?: React.CSSProperties;
}

// Constants for performance and consistency
const LYRICS_CONSTANTS = {
    BLUR_AMOUNT: 1,
    BLUR_OPACITY: 0.7,
    LETTER_BUFFER: 0.05,
    WAVE_DISTANCE: 4,
    WAVE_TRAVEL_DISTANCE: 10,
    ANTICIPATION_S: 0.5,
    WAVE_CLEAR_DURATION_S: 0.2,
    FOCUS_PRE_BUFFER_S: 0.5,
    FOCUS_POST_BUFFER_S: 0.1,
    FOCUS_OFFSET: 20, // Allow focus to trigger slightly before line start
    ARTIFICIAL_INWARD_BUFFER_S: 0.8,
    RAF_THROTTLE_MS: (1/30)*1000, // ~30fps for smoother wave animations
    SCROLL_DEBOUNCE_MS: 20,
    INTERLUDE_THRESHOLD_S: 3.0
} as const;

export const SyncedLyricsBody = React.memo<SyncedLyricsBodyProps>(({ lines, precomputedLinesData, focusIndex, activeLineRef, effectivePosition, style }) => {
    const { LETTER_BUFFER, WAVE_DISTANCE, RAF_THROTTLE_MS } = LYRICS_CONSTANTS;

    // Round effective position to reduce excessive re-renders
    const roundedPosition = useMemo(() => {
        return Math.round(effectivePosition * RAF_THROTTLE_MS) / RAF_THROTTLE_MS; // Round to 50ms precision
    }, [effectivePosition]);

    // Memoize expensive calculations that don't change frequently
    const memoizedLineElements = useMemo(() => {
        return lines.map((ln, i) => {
            const data = precomputedLinesData[i];
            if (!data) return null;

            const { isFocus, isActive, wasActive, isPlayed, isLast, peakIdx, wordData } = data;

            // Pre-calculate class names
            const lineClassName = 
                `lyric-line` +
                (isActive ? ' active' : '') +
                (isPlayed ? ' played' : '') +
                (wasActive ? ' wasactive' : '') +
                (isLast ? ' last' : '') +
                (ln.isArtificial ? ' artificial' : '');

            let letterPosInLine = 0;

            const lineContent = ln.parts ? (
                ln.parts.map((p, j) => {
                    const wordStartPos = letterPosInLine;
                    const isWordActive = wordData?.[j]?.isActive ?? false;
                    const nextPart = ln.parts![j + 1];
                    const partEnd = nextPart?.start ?? ln.end;
                    const partDuration = partEnd - p.start;

                    // Pre-calculate word classes
                    const wordClassName = `lyric-word${p.text.trim() === '' ? ' space' : ''}${isWordActive ? ' active' : ''}`;

                    // Pre-calculate letter elements for this word
                    const letterElements = p.text.split('').map((letter, idx) => {
                        if (letter === ' ') {
                            return <span key={idx}>&nbsp;</span>;
                        }

                        const currentLetterPos = wordStartPos + idx;
                        const distance = Math.abs(currentLetterPos - peakIdx);
                        const t = Math.max(0, 1 - distance / WAVE_DISTANCE);
                        
                        // Smoother wave function using sine wave for more natural movement
                        const smoothT = t * t * (3 - 2 * t); // Smoothstep function
                        const waveY = Math.sin(smoothT * Math.PI * 0.5) * 6; // Reduced amplitude for subtlety

                        // Improved letter timing for rich sync precision
                        const letterDuration = partDuration / Math.max(1, p.text.length);
                        const letterStart = p.start + (idx * letterDuration);
                        const letterEnd = letterStart + letterDuration;

                        // More precise timing check with small buffer for smooth transitions
                        const hasPeaked = roundedPosition >= (letterStart - LETTER_BUFFER);
                        const isCurrentLetter = roundedPosition >= letterStart && roundedPosition < letterEnd;
                        const shouldHighlight = isPlayed || hasPeaked;

                        // Pre-calculate letter classes
                        const letterClassName = `letter${shouldHighlight ? ' sung' : ''}${isCurrentLetter ? ' current' : ''}`;

                        // Use CSS custom property for smoother animations
                        // Round waveY to reduce micro-updates that cause stuttering
                        const roundedWaveY = Math.round(waveY * 10) / 10;
                        const letterStyle = {
                            '--wave-y': `${-roundedWaveY}px`
                        } as React.CSSProperties;

                        return (
                            <span
                                key={idx}
                                className={letterClassName}
                                style={letterStyle}
                            >
                                {letter}
                            </span>
                        );
                    });

                    const result = (
                        <span key={j} className={wordClassName}>
                            <span className="word-text">
                                {letterElements}
                            </span>
                        </span>
                    );
                    
                    letterPosInLine += p.text.length;
                    return result;
                })
            ) : (
                <span>{ln.text}</span>
            );

            return {
                key: i,
                isFocus,
                className: lineClassName,
                content: lineContent,
                dataIndex: i
            };
        });
    }, [lines, precomputedLinesData, roundedPosition, LETTER_BUFFER, WAVE_DISTANCE]);

    return (
        <div className="lyrics-body" style={{ margin: 0, ...style }}>
            {memoizedLineElements.map((lineElement) => {
                if (!lineElement) return null;

                return (
                    <div
                        key={lineElement.key}
                        ref={lineElement.isFocus ? activeLineRef : undefined}
                        className={lineElement.className}
                        data-index={lineElement.dataIndex}
                        aria-current={lineElement.isFocus ? 'true' : undefined}
                    >
                        {lineElement.content}
                    </div>
                );
            })}
        </div>
    );
});
SyncedLyricsBody.displayName = 'SyncedLyricsBody';

// Utility function for safe HTML processing
export const sanitizeAndProcessLyrics = (lyrics: string | undefined, fallbackText: string): string => {
    if (!lyrics) return fallbackText;

    const cleanLyrics = lyrics
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '');

    return cleanLyrics;
};

// Custom hook for lyrics position tracking and interpolation
export function useLyricsPositionTracking() {
    const position = usePlaybackSelector(s => s.position);
    const playing = usePlaybackSelector(s => s.playing);

    // High-precision local position interpolation with improved accuracy
    const [derivedPosition, setDerivedPosition] = useState<number>(position ?? 0);
    const basePosRef = useRef<number>(position ?? 0);
    const baseTsRef = useRef<number>(performance.now());
    const rafRef = useRef<number | null>(null);
    const isInterpolatingRef = useRef<boolean>(false);
    const lastTickTimeRef = useRef<number>(0);

    // Optimized tick function with throttling
    const tick = useCallback(() => {
        if (!isInterpolatingRef.current) {
            rafRef.current = null;
            return;
        }

        const now = performance.now();
        
        // Throttle updates to ~60fps maximum
        if (now - lastTickTimeRef.current < LYRICS_CONSTANTS.RAF_THROTTLE_MS) {
            rafRef.current = requestAnimationFrame(tick);
            return;
        }

        lastTickTimeRef.current = now;
        const interpolatedTime = basePosRef.current + (now - baseTsRef.current) / 1000;
        setDerivedPosition(interpolatedTime);
        rafRef.current = requestAnimationFrame(tick);
    }, []);

    // Consolidated effect for handling position updates and RAF lifecycle
    useEffect(() => {
        const currentPosition = position ?? 0;

        if (playing) {
            const now = performance.now();

            // Check if we need to sync position
            const currentInterpolated = basePosRef.current + (now - baseTsRef.current) / 1000;
            const positionDrift = Math.abs(currentPosition - currentInterpolated);

            // Sync if drift is significant or if position jumped
            if (positionDrift > 0.25 || Math.abs(currentPosition - basePosRef.current) > 1.0) {
                basePosRef.current = currentPosition;
                baseTsRef.current = now;
                setDerivedPosition(currentPosition);
            }

            // Start interpolation if not already running
            if (!isInterpolatingRef.current) {
                isInterpolatingRef.current = true;
                basePosRef.current = currentPosition;
                baseTsRef.current = now;
                setDerivedPosition(currentPosition);
                
                if (!rafRef.current) {
                    rafRef.current = requestAnimationFrame(tick);
                }
            }
        } else {
            // Stop interpolation and use exact position
            isInterpolatingRef.current = false;
            setDerivedPosition(currentPosition);
            
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        }

        // Cleanup on unmount
        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            isInterpolatingRef.current = false;
        };
    }, [playing, position, tick]);

    return { derivedPosition, playing, position };
}

// Custom hook for lyrics settings management
export function useLyricsSettings() {
    const [syncOffsetMs, setSyncOffsetMs] = useState<number>(0);
    const [lyricsSource, setLyricsSource] = useState<'genius' | 'musixmatch'>('musixmatch');
    const [fontSize, setFontSize] = useState<number>(50); // Multiplier percentage (e.g., 50 means 50%)
    const [menuUpdateTrigger, setMenuUpdateTrigger] = useState<number>(0);

    const { t } = useI18n();
    const { openMenu } = useContextMenu();

    // Memoized menu items function that depends on state
    const menuItems = useCallback((): ContextMenuItem[] => [
        {
            id: 'title',
            label: 'title',
            type: 'custom',
            hideNoImage: true,
            meta: {
                title: t('common.LyricsOptions')
            }
        },
        {
            id: 'offset',
            label: 'Offset',
            type: 'inline',
            items: [
                {
                    id: 'offset-decrease-large',
                    label: '≪',
                    type: 'action',
                    width: 30,
                    updateOnClick: true,
                    onClick: () => setSyncOffsetMs(v => v - 500)
                },
                {
                    id: 'offset-decrease',
                    label: '-',
                    type: 'action',
                    width: 30,
                    updateOnClick: true,
                    onClick: () => setSyncOffsetMs(v => v - 100)
                },
                {
                    id: 'offset-current',
                    label: `${syncOffsetMs}ms`,
                    type: 'action',
                    width: 94,
                    disabled: true
                },
                {
                    id: 'offset-increase',
                    label: '+',
                    type: 'action',
                    width: 30,
                    updateOnClick: true,
                    onClick: () => setSyncOffsetMs(v => v + 100)
                },
                {
                    id: 'offset-increase-large',
                    label: '≫',
                    type: 'action',
                    width: 30,
                    updateOnClick: true,
                    onClick: () => setSyncOffsetMs(v => v + 500)
                }
            ]
        },
        {
            id: 'offset-reset',
            label: 'Reset Offset',
            type: 'action',
            icon: 'restart_alt',
            updateOnClick: true,
            onClick: () => setSyncOffsetMs(0)
        },
        {
            id: 'lyrics-source',
            label: 'Lyrics Source',
            type: 'group',
            title: 'Lyrics Source',
            items: [
                {
                    id: 'source-musixmatch',
                    label: 'Musixmatch',
                    type: 'action',
                    icon: lyricsSource === 'musixmatch' ? 'radio_button_checked' : 'radio_button_unchecked',
                    iconPosition: 'left',
                    updateOnClick: true,
                    onClick: () => setLyricsSource('musixmatch')
                }
            ]
        },
        {
            id: 'font-size',
            label: 'Font Size',
            type: 'inline',
            items: [
                {
                    id: 'font-decrease',
                    label: '-',
                    type: 'action',
                    width: 60,
                    updateOnClick: true,
                    onClick: () => setFontSize(v => Math.max(1, v - 1))
                },
                {
                    id: 'font-current',
                    label: `${fontSize}%`,
                    type: 'action',
                    disabled: true
                },
                {
                    id: 'font-increase',
                    label: '+',
                    type: 'action',
                    width: 60,
                    updateOnClick: true,
                    onClick: () => setFontSize(v => Math.min(100, v + 1))
                }
            ]
        }
    ], [syncOffsetMs, lyricsSource, fontSize, t]);

    // Ref to current menuItems
    const menuItemsRef = useRef(menuItems);
    menuItemsRef.current = menuItems;

    const handleSettingsClick = useCallback(async (e: React.MouseEvent) => {
        e.stopPropagation();

        await openMenu({
            e,
            items: () => menuItemsRef.current(),
            preventCloseOnClick: true,
            onUpdate: () => setMenuUpdateTrigger(prev => prev + 1)
        });
    }, [openMenu, menuUpdateTrigger]);

    // Reset offset when title changes
    const resetOffsetOnTitleChange = useCallback((title: string | undefined) => {
        setSyncOffsetMs(0);
    }, []);

    return {
        syncOffsetMs,
        setSyncOffsetMs,
        lyricsSource,
        setLyricsSource,
        fontSize,
        setFontSize,
        handleSettingsClick,
        resetOffsetOnTitleChange
    };
}

// Custom hook for lyrics data processing and normalization
export function useLyricsData(synced?: SyncedLyrics | MusixmatchRichSync) {
    const normalizedLyrics = useMemo((): SyncedLyrics | undefined => {
        if (!synced) return undefined;

        let initialLines: InternalLyricsLine[] = [];

        if (Array.isArray(synced) && 'ts' in synced[0]) {
            const musixmatchData = synced as MusixmatchRichSync;
            initialLines = musixmatchData.map(line => ({
                start: line.ts,
                end: line.te,
                text: line.x,
                parts: line.l.map(part => ({ text: part.c, start: line.ts + part.o })),
            }));
        } else {
            initialLines = (synced as SyncedLyrics).lines;
        }

        const linesWithInterludes: InternalLyricsLine[] = [];
        const { INTERLUDE_THRESHOLD_S } = LYRICS_CONSTANTS;

        for (let i = 0; i < initialLines.length; i++) {
            const currentLine = initialLines[i];
            linesWithInterludes.push(currentLine);

            const nextLine = initialLines[i + 1];
            if (nextLine) {
                const gap = nextLine.start - currentLine.end;
                if (gap > INTERLUDE_THRESHOLD_S) {
                    const interludeStart = currentLine.end;
                    const interludeEnd = nextLine.start;
                    const interludeDuration = interludeEnd - interludeStart;
                    const dots = ['•', '•', '•'];
                    const partDuration = interludeDuration / dots.length;

                    linesWithInterludes.push({
                        text: '•••',
                        start: interludeStart,
                        end: interludeEnd,
                        isArtificial: true,
                        parts: dots.map((dot, index) => ({ text: dot, start: interludeStart + (index * partDuration) })),
                    });
                }
            }
        }

        return { lines: linesWithInterludes };
    }, [synced]);

    return normalizedLyrics;
}

// Custom hook for lyrics timing and focus management
export function useLyricsTiming(
    normalizedLyrics: SyncedLyrics | undefined,
    effectivePosition: number
) {
    const [previousFocusIndex, setPreviousFocusIndex] = useState<number>(-1);
    const [lastLineIndex, setLastLineIndex] = useState<number>(-1);

    const hasSynced = !!(normalizedLyrics?.lines?.length);
    const lines = normalizedLyrics?.lines || [];

    // Memoize words per line for efficient lookup - only recreate when lines change
    const { allWords, wordsPerLine } = useMemo(() => {
        if (!hasSynced || lines.length === 0) {
            return { allWords: [], wordsPerLine: new Map<number, any[]>() };
        }

        const words: Array<{
            text: string;
            start: number;
            lineIndex: number;
            partIndex: number;
            letterOffset: number;
        }> = [];
        
        const lineWordMap = new Map<number, typeof words>();

        lines.forEach((line, lineIndex) => {
            if (!line.parts) return;
            
            let letterOffset = 0;
            const lineWords: typeof words = [];
            
            line.parts.forEach((part, partIndex) => {
                const wordInfo = {
                    text: part.text,
                    start: part.start,
                    lineIndex,
                    partIndex,
                    letterOffset
                };
                words.push(wordInfo);
                lineWords.push(wordInfo);
                letterOffset += part.text.length;
            });
            
            lineWordMap.set(lineIndex, lineWords);
        });

        return { allWords: words, wordsPerLine: lineWordMap };
    }, [lines, hasSynced]);

    // Optimize active word finding with binary search approach
    const activeWordGlobalIndex = useMemo(() => {
        if (allWords.length === 0 || !isFinite(effectivePosition) || effectivePosition < 0) {
            return -1;
        }

        // Binary search for better performance on large datasets
        let left = 0;
        let right = allWords.length - 1;
        let lastValidIndex = -1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (allWords[mid].start <= effectivePosition) {
                lastValidIndex = mid;
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return lastValidIndex;
    }, [allWords, effectivePosition]);

    const { focusIndex, activeIndices } = useMemo(() => {
        if (!hasSynced || lines.length === 0) return { focusIndex: -1, activeIndices: [] };

        const { FOCUS_PRE_BUFFER_S, FOCUS_POST_BUFFER_S, ARTIFICIAL_INWARD_BUFFER_S, FOCUS_OFFSET } = LYRICS_CONSTANTS;

        // Validate effective position is reasonable
        if (!isFinite(effectivePosition) || effectivePosition < 0) {
            return { focusIndex: -1, activeIndices: [] };
        }

        const activeCandidates: number[] = [];
        let primaryIndex = -1;
        let lastPassedLine = -1;

        // Single pass through lines for better performance
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Validate line timing data
            if (!isFinite(line.start) || !isFinite(line.end) || line.start > line.end) {
                continue;
            }

            // Track passed lines for primary index fallback
            if (line.start <= effectivePosition) {
                lastPassedLine = i;
            }

            // Check if line is active
            let lineIsActive = false;
            if (line.isArtificial) {
                lineIsActive = effectivePosition >= (line.start + ARTIFICIAL_INWARD_BUFFER_S) &&
                    effectivePosition < (line.end - ARTIFICIAL_INWARD_BUFFER_S);
            } else {
                lineIsActive = effectivePosition >= (line.start - FOCUS_PRE_BUFFER_S) &&
                    effectivePosition < (line.end + FOCUS_POST_BUFFER_S);
            }

            if (lineIsActive) {
                activeCandidates.push(i);
            }

            // Check for primary index (currently playing line)
            if (primaryIndex === -1 && effectivePosition >= line.start - FOCUS_OFFSET && effectivePosition < line.end) {
                primaryIndex = i;
            }
        }

        // Use fallback if no primary index found
        if (primaryIndex === -1) {
            primaryIndex = lastPassedLine;
        }

        return { focusIndex: primaryIndex, activeIndices: activeCandidates };
    }, [hasSynced, lines, effectivePosition]);

    useEffect(() => {
        setLastLineIndex(previousFocusIndex);
        setPreviousFocusIndex(focusIndex);
    }, [focusIndex, previousFocusIndex]);

    // Optimize isSongFinished check
    const isSongFinished = useMemo(() => {
        if (lines.length === 0) return false;
        return effectivePosition >= lines[lines.length - 1]?.end;
    }, [effectivePosition, lines]);

    const precomputedLinesData = useMemo((): PrecomputedLineData[] => {
        if (!hasSynced) return [];

        const { WAVE_TRAVEL_DISTANCE, ANTICIPATION_S, WAVE_CLEAR_DURATION_S } = LYRICS_CONSTANTS;

        // Get active word info once and reuse
        const activeWord = activeWordGlobalIndex !== -1 ? allWords[activeWordGlobalIndex] : null;
        const nextWord = activeWordGlobalIndex !== -1 ? allWords[activeWordGlobalIndex + 1] : null;

        return lines.map((ln, i) => {
            const isFocus = i === focusIndex;
            const isActive = activeIndices.includes(i) || i === focusIndex;
            const wasActive = isActive && !isFocus;

            let isLast = false;
            if (isSongFinished) {
                isLast = i === lines.length - 1;
            } else {
                isLast = i === lastLineIndex && !isActive;
            }

            const isPlayed = effectivePosition >= ln.end && !isFocus && !isLast;

            let peakIdx = -WAVE_TRAVEL_DISTANCE;

            const animAnticipationEnd = ln.start;
            const animAnticipationStart = animAnticipationEnd - ANTICIPATION_S;
            const animExitStart = ln.end;
            const animExitEnd = animExitStart + WAVE_CLEAR_DURATION_S;

            if (effectivePosition >= animAnticipationStart && effectivePosition < animAnticipationEnd) {
                const progress = (effectivePosition - animAnticipationStart) / ANTICIPATION_S;
                peakIdx = (progress * WAVE_TRAVEL_DISTANCE) - WAVE_TRAVEL_DISTANCE;
            } else if (effectivePosition >= animAnticipationEnd && effectivePosition < animExitStart) {
                if (activeWord && activeWord.lineIndex === i) {
                    const wordStart = activeWord.start;
                    const wordEnd = nextWord?.start ?? ln.end;
                    const wordDuration = Math.max(0.1, wordEnd - wordStart);
                    const progressInWord = Math.max(0, Math.min(1, (effectivePosition - wordStart) / wordDuration));
                    peakIdx = activeWord.letterOffset + (progressInWord * activeWord.text.length);
                } else {
                    const wordsInLine = wordsPerLine.get(i) || [];
                    const lastWordInLine = wordsInLine.slice().reverse().find(w => w.start <= effectivePosition);
                    peakIdx = lastWordInLine ? lastWordInLine.letterOffset + lastWordInLine.text.length : 0;
                }
            } else if (effectivePosition >= animExitStart && effectivePosition < animExitEnd) {
                const progress = (effectivePosition - animExitStart) / WAVE_CLEAR_DURATION_S;
                peakIdx = ln.text.length + (progress * WAVE_TRAVEL_DISTANCE);
            } else if (isPlayed || (isLast && isSongFinished)) {
                peakIdx = ln.text.length + WAVE_TRAVEL_DISTANCE;
            }

            const wordData = ln.parts?.map((part, partIndex) => ({
                isActive: activeWord?.lineIndex === i && activeWord?.partIndex === partIndex,
            }));

            return { isFocus, isActive, wasActive, isPlayed, isLast, peakIdx, wordData };
        });
    }, [hasSynced, lines, focusIndex, activeIndices, effectivePosition, lastLineIndex, allWords, activeWordGlobalIndex, isSongFinished, wordsPerLine]);

    return {
        hasSynced,
        lines,
        focusIndex,
        activeIndices,
        precomputedLinesData
    };
}

// Base lyrics component that both overlay and tab components can use
export interface BaseLyricsComponentProps extends LyricsProps {
    className?: string;
    containerRef?: React.RefObject<HTMLDivElement>;
    onSettingsClick?: (e: React.MouseEvent) => void;
    showSettings?: boolean;
    showCloseButton?: boolean;
    showSwitchButton?: boolean;
    switchButtonIcon?: string;
    onClose?: () => void;
    onSwitchPanel?: () => void;
}

export function BaseLyricsComponent({
    lyrics,
    title,
    synced,
    className = '',
    containerRef,
    onSettingsClick,
    showSettings = true,
    showCloseButton = false,
    showSwitchButton = false,
    switchButtonIcon = 'dock_to_left',
    onClose,
    onSwitchPanel
}: BaseLyricsComponentProps) {
    const { t } = useI18n();
    const activeLineRef = useRef<HTMLDivElement | null>(null);
    const scrollTimeoutRef = useRef<number | null>(null);
    const lastScrollFocusRef = useRef<number>(-1);
    const isManualScrollingRef = useRef<boolean>(false);

    // Use custom hooks for functionality
    const { derivedPosition, playing, position } = useLyricsPositionTracking();
    const { syncOffsetMs, fontSize, handleSettingsClick, resetOffsetOnTitleChange } = useLyricsSettings();
    const normalizedLyrics = useLyricsData(synced);

    // Calculate effective position with sync offset
    const effectivePosition = useMemo(() => {
        const baseTime = playing ? derivedPosition : (position ?? 0);
        return baseTime + (syncOffsetMs / 1000);
    }, [derivedPosition, position, syncOffsetMs, playing]);

    const { hasSynced, lines, focusIndex, precomputedLinesData } = useLyricsTiming(normalizedLyrics, effectivePosition);

    // Reset offset when title changes
    useEffect(() => {
        resetOffsetOnTitleChange(title);
    }, [title, resetOffsetOnTitleChange]);

    // Optimized scroll-to-line function with debouncing
    const scrollToActiveLine = useCallback(() => {
        if (!hasSynced || !activeLineRef.current || focusIndex === lastScrollFocusRef.current) {
            return;
        }

        // Clear any pending scroll operations
        if (scrollTimeoutRef.current) {
            clearTimeout(scrollTimeoutRef.current);
        }

        // Debounce scroll operations to prevent excessive DOM manipulation
        scrollTimeoutRef.current = window.setTimeout(() => {
            if (activeLineRef.current && !isManualScrollingRef.current) {
                activeLineRef.current.scrollIntoView({ 
                    block: 'center', 
                    behavior: 'smooth' 
                });
                lastScrollFocusRef.current = focusIndex;
            }
        }, LYRICS_CONSTANTS.SCROLL_DEBOUNCE_MS);
    }, [hasSynced, focusIndex]);

    // Auto-scroll to active line when focus changes
    useLayoutEffect(() => {
        scrollToActiveLine();
    }, [scrollToActiveLine]);

    // Optimized resize handling with improved debouncing
    useEffect(() => {
        let resizeTimeout: number | null = null;
        let resizeStartTime: number = 0;

        const onResizeStart = () => {
            resizeStartTime = performance.now();
            isManualScrollingRef.current = true; // Prevent auto-scroll during resize
        };

        const onResizeEnd = () => {
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }

            // Use adaptive timeout based on resize duration
            const resizeDuration = performance.now() - resizeStartTime;
            const timeoutDuration = Math.min(300, Math.max(100, resizeDuration * 0.5));

            resizeTimeout = window.setTimeout(() => {
                isManualScrollingRef.current = false;
                scrollToActiveLine();
            }, timeoutDuration);
        };

        // Use ResizeObserver for better performance when available
        if (containerRef?.current && 'ResizeObserver' in window) {
            const resizeObserver = new ResizeObserver((entries) => {
                if (entries.length > 0) {
                    onResizeStart();
                    onResizeEnd();
                }
            });

            resizeObserver.observe(containerRef.current);

            return () => {
                resizeObserver.disconnect();
                if (resizeTimeout) clearTimeout(resizeTimeout);
                if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
            };
        } else {
            // Fallback to window resize events
            window.addEventListener('resize', onResizeStart);
            window.addEventListener('resize', onResizeEnd);

            return () => {
                window.removeEventListener('resize', onResizeStart);
                window.removeEventListener('resize', onResizeEnd);
                if (resizeTimeout) clearTimeout(resizeTimeout);
                if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
            };
        }
    }, [scrollToActiveLine, containerRef]);

    // Handle playback state changes
    useEffect(() => {
        if (playing && hasSynced) {
            // Reset manual scrolling flag when playback starts
            isManualScrollingRef.current = false;
            // Use a small delay to ensure the position is stable
            const playbackScrollTimeout = setTimeout(() => {
                scrollToActiveLine();
            }, 100);

            return () => clearTimeout(playbackScrollTimeout);
        }
    }, [playing, hasSynced, scrollToActiveLine]);

    // Cleanup timeouts on unmount
    useEffect(() => {
        return () => {
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
        };
    }, []);

    const processedLyrics = useMemo(() => sanitizeAndProcessLyrics(lyrics, t('lyrics.unavailable')), [lyrics, t]);

    const handleContentClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
    }, []);

    return (
        <div className={`np-lyrics-container ${className}`} onClick={handleContentClick} ref={containerRef}>
            <div className="np-lyrics-header">
                {showCloseButton && onClose && (
                    <button type="button" className="player-icons lyrics-btn lyrics-close-btn" aria-label={t('lyrics.close')} onClick={onClose}>
                        <span className="material-symbols-rounded filled">close</span>
                    </button>
                )}
                {showSwitchButton && onSwitchPanel && (
                    <button type="button" className="player-icons lyrics-btn lyrics-switch-btn" aria-label={t('lyrics.switchPanel')} onClick={onSwitchPanel}>
                        <span className="material-symbols-rounded filled">{switchButtonIcon}</span>
                    </button>
                )}
                {hasSynced && showSettings && (
                    <button
                        type="button"
                        className="player-icons lyrics-btn lyrics-settings-btn"
                        aria-label="Lyrics settings"
                        onClick={onSettingsClick || handleSettingsClick}
                        title="Lyrics settings"
                    >
                        <span className="material-symbols-rounded">settings</span>
                    </button>
                )}
            </div>
            <div className="np-lyrics-blur">
            </div>
            <div className={`np-lyrics-scroll`}>
                <div className="np-lyrics-body">
                    {hasSynced ? (
                        <SyncedLyricsBody
                            lines={lines}
                            precomputedLinesData={precomputedLinesData}
                            focusIndex={focusIndex}
                            activeLineRef={activeLineRef}
                            effectivePosition={effectivePosition}
                            style={{ '--lyrics-font-multiplier': fontSize / 50 } as React.CSSProperties}
                        />
                    ) : (
                        <div
                            className="lyrics-body"
                            style={{ margin: 0, '--lyrics-font-multiplier': fontSize / 50 } as React.CSSProperties}
                            dangerouslySetInnerHTML={{ __html: processedLyrics }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

export type { MusixmatchRichSync, InternalLyricsLine, InternalLyricsPart };