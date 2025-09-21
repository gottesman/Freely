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
    isRightPanel?: boolean; // New prop to indicate if this is in right panel
}

export const SyncedLyricsBody = React.memo<SyncedLyricsBodyProps>(({ lines, precomputedLinesData, focusIndex, activeLineRef, effectivePosition, style, isRightPanel = false }) => (
    <div className="lyrics-body" style={{ margin: 0, ...style }}>
        {lines.map((ln, i) => {
            const data = precomputedLinesData[i];
            if (!data) return null;

            const { isFocus, isActive, wasActive, isPlayed, isLast, peakIdx, wordData } = data;

            // For right panel: no blur, fixed opacity
            // For center panel: dynamic blur and opacity based on focus
            const shouldBlur = !isRightPanel && !isFocus && !isActive && !isLast && !isPlayed;
            const blurAmount = isRightPanel ? 0 : Math.abs(i - 1 - focusIndex) * 0.5;
            const opacity = isRightPanel ? 0.7 : Math.max(0, 1 - Math.abs(i - focusIndex) * 0.3);
            let letterPosInLine = 0;
            return (
                <div
                    key={i}
                    ref={isFocus ? activeLineRef : undefined}
                    className={
                        `lyric-line` +
                        (isActive ? ' active' : '') +
                        (isPlayed ? ' played' : '') +
                        (wasActive ? ' wasactive' : '') +
                        (isLast ? ' last' : '') +
                        (ln.isArtificial ? ' artificial' : '')
                    }
                    style={shouldBlur ? { filter: `blur(${blurAmount}px)`, opacity: opacity } : undefined}
                    data-index={i}
                    aria-current={isFocus ? 'true' : undefined}
                >
                    {ln.parts ? (
                        ln.parts.map((p, j) => {
                            const wordStartPos = letterPosInLine;
                            const isWordActive = wordData?.[j]?.isActive ?? false;
                            const nextPart = ln.parts[j + 1];
                            const partEnd = nextPart?.start ?? ln.end;
                            const partDuration = partEnd - p.start;
                            const result = (
                                <span key={j} className={`lyric-word${p.text.trim() === '' ? ' space' : ''}${isWordActive ? ' active' : ''}`}>
                                    <span className="word-text">
                                        {p.text.split('').map((letter, idx) => {
                                            if (letter === ' ') return <span key={idx}>&nbsp;</span>;

                                            const currentLetterPos = wordStartPos + idx;
                                            const distance = Math.abs(currentLetterPos - peakIdx);
                                            const t = Math.max(0, 1 - distance / 4);
                                            const waveY = t * t * (3 - 2 * t) * 5;

                                            // Improved letter timing for rich sync precision
                                            const letterDuration = partDuration / Math.max(1, p.text.length);
                                            const letterStart = p.start + (idx * letterDuration);
                                            const letterEnd = letterStart + letterDuration;

                                            // More precise timing check with small buffer for smooth transitions
                                            const LETTER_BUFFER = 0.05; // 50ms buffer for smoother animation
                                            const hasPeaked = effectivePosition >= (letterStart - LETTER_BUFFER);
                                            const isCurrentLetter = effectivePosition >= letterStart && effectivePosition < letterEnd;
                                            const shouldHighlight = isPlayed || hasPeaked;

                                            return (
                                                <span
                                                    key={idx}
                                                    className={`letter${shouldHighlight ? ' sung' : ''}${isCurrentLetter ? ' current' : ''}`}
                                                    style={{ transform: `translateY(${-waveY}px)` }}
                                                >
                                                    {letter}
                                                </span>
                                            );
                                        })}
                                    </span>
                                </span>
                            );
                            letterPosInLine += p.text.length;
                            return result;
                        })
                    ) : (
                        <span>{ln.text}</span>
                    )}
                </div>
            );
        })}
    </div>
));
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

    const tick = useCallback(() => {
        if (playing && isInterpolatingRef.current) {
            const now = performance.now();
            const interpolatedTime = basePosRef.current + (now - baseTsRef.current) / 1000;
            setDerivedPosition(interpolatedTime);
        }
        rafRef.current = requestAnimationFrame(tick);
    }, [playing]);

    // Update base position when playback position changes significantly
    useEffect(() => {
        const now = performance.now();
        const currentInterpolated = basePosRef.current + (now - baseTsRef.current) / 1000;
        const positionDrift = Math.abs((position ?? 0) - currentInterpolated);

        // Sync if drift is more than 250ms or if position jumped significantly
        if (positionDrift > 0.25 || Math.abs((position ?? 0) - basePosRef.current) > 1.0) {
            console.log('🎵 Lyrics sync: Updating base position', {
                newPosition: position,
                drift: positionDrift,
                wasInterpolated: currentInterpolated
            });
            basePosRef.current = position ?? 0;
            baseTsRef.current = now;
            setDerivedPosition(position ?? 0);
        }
    }, [position]);

    // Start/stop interpolation based on playing state
    useEffect(() => {
        if (playing) {
            isInterpolatingRef.current = true;
            basePosRef.current = position ?? 0;
            baseTsRef.current = performance.now();
            setDerivedPosition(position ?? 0);
            if (!rafRef.current) {
                rafRef.current = requestAnimationFrame(tick);
            }
        } else {
            isInterpolatingRef.current = false;
            // Use exact position when not playing
            setDerivedPosition(position ?? 0);
        }

        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [playing, tick, position]);

    return { derivedPosition, playing, position };
}

// Custom hook for lyrics settings management
export function useLyricsSettings() {
    const [syncOffsetMs, setSyncOffsetMs] = useState<number>(0);
    const [lyricsSource, setLyricsSource] = useState<'genius' | 'musixmatch'>('musixmatch');
    const [richSyncEnabled, setRichSyncEnabled] = useState<boolean>(true);
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
    ], [syncOffsetMs, lyricsSource, richSyncEnabled, fontSize, t]);

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
        richSyncEnabled,
        setRichSyncEnabled,
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
        const INTERLUDE_THRESHOLD_S = 3.0;

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

    const { focusIndex, activeIndices } = useMemo(() => {
        if (!hasSynced || lines.length === 0) return { focusIndex: -1, activeIndices: [] };

        const FOCUS_PRE_BUFFER_S = 0.1;
        const FOCUS_POST_BUFFER_S = 0.5;
        const ARTIFICIAL_INWARD_BUFFER_S = 0.3;

        // Validate effective position is reasonable
        if (!isFinite(effectivePosition) || effectivePosition < 0) {
            console.warn('🎵 Invalid effective position:', effectivePosition);
            return { focusIndex: -1, activeIndices: [] };
        }

        const activeCandidates: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Validate line timing data
            if (!isFinite(line.start) || !isFinite(line.end) || line.start > line.end) {
                console.warn('🎵 Invalid line timing:', line);
                continue;
            }

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
        }

        let primaryIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (effectivePosition >= lines[i].start && effectivePosition < lines[i].end) {
                primaryIndex = i;
                break;
            }
        }

        if (primaryIndex === -1) {
            let lastPassedLine = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].start <= effectivePosition) {
                    lastPassedLine = i;
                } else {
                    break;
                }
            }
            primaryIndex = lastPassedLine;
        }

        return { focusIndex: primaryIndex, activeIndices: activeCandidates };
    }, [hasSynced, lines, effectivePosition]);

    useEffect(() => {
        setLastLineIndex(previousFocusIndex);
        setPreviousFocusIndex(focusIndex);
    }, [focusIndex]);

    const precomputedLinesData = useMemo((): PrecomputedLineData[] => {
        if (!hasSynced) return [];

        const WAVE_TRAVEL_DISTANCE = 10;
        const ANTICIPATION_S = 0.2;
        const WAVE_CLEAR_DURATION_S = 0.5;

        const allWords = lines.flatMap((line, lineIndex) => {
            let letterOffset = 0;
            return (line.parts || []).map((part, partIndex) => {
                const wordInfo = { ...part, lineIndex, partIndex, letterOffset };
                letterOffset += part.text.length;
                return wordInfo;
            });
        });

        let activeWordGlobalIndex = -1;
        for (let i = 0; i < allWords.length; i++) {
            if (allWords[i].start <= effectivePosition) {
                activeWordGlobalIndex = i;
            } else {
                break;
            }
        }

        // **THE FIX**: Determine if the entire song is finished to apply special `.last` class logic.
        const isSongFinished = effectivePosition >= lines[lines.length - 1].end;

        return lines.map((ln, i) => {
            const isFocus = i === focusIndex;
            const isActive = activeIndices.includes(i) || i === focusIndex;
            const wasActive = isActive && !isFocus;

            let isLast = false;
            if (isSongFinished) {
                // If song is over, only the very last line gets the .last class.
                isLast = i === lines.length - 1;
            } else {
                // Otherwise, the line that was previously focus but is no longer active is the .last line.
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
                const activeWord = activeWordGlobalIndex !== -1 && allWords[activeWordGlobalIndex]?.lineIndex === i ? allWords[activeWordGlobalIndex] : null;
                if (activeWord) {
                    const nextWord = allWords[activeWordGlobalIndex + 1];
                    const wordStart = activeWord.start;
                    const wordEnd = nextWord?.start ?? ln.end;
                    const wordDuration = Math.max(0.1, wordEnd - wordStart);
                    const progressInWord = Math.max(0, Math.min(1, (effectivePosition - wordStart) / wordDuration));
                    peakIdx = activeWord.letterOffset + (progressInWord * activeWord.text.length);
                } else {
                    const lastWordInLine = allWords.slice().reverse().find(w => w.lineIndex === i && w.start <= effectivePosition);
                    peakIdx = lastWordInLine ? lastWordInLine.letterOffset + lastWordInLine.text.length : 0;
                }
            } else if (effectivePosition >= animExitStart && effectivePosition < animExitEnd) {
                const progress = (effectivePosition - animExitStart) / WAVE_CLEAR_DURATION_S;
                peakIdx = ln.text.length + (progress * WAVE_TRAVEL_DISTANCE);
            } else if (isPlayed || (isLast && isSongFinished)) {
                peakIdx = ln.text.length + WAVE_TRAVEL_DISTANCE;
            }

            const activeWordInThisLine = activeWordGlobalIndex !== -1 && allWords[activeWordGlobalIndex]?.lineIndex === i ? allWords[activeWordGlobalIndex] : null;
            const wordData = ln.parts?.map((part, partIndex) => ({
                isActive: activeWordInThisLine?.partIndex === partIndex,
            }));

            return { isFocus, isActive, wasActive, isPlayed, isLast, peakIdx, wordData };
        });
    }, [hasSynced, lines, focusIndex, activeIndices, effectivePosition, lastLineIndex]);

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

    // Determine if this is being used in the right panel
    const isRightPanel = className.includes('right-panel-lyrics');

    // Reset offset when title changes
    useEffect(() => {
        resetOffsetOnTitleChange(title);
    }, [title, resetOffsetOnTitleChange]);

    // Auto-scroll to active line
    useLayoutEffect(() => {
        if (hasSynced && activeLineRef.current) {
            activeLineRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }, [hasSynced, focusIndex]);

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
            <div className={`np-lyrics-scroll`}>
                <div className="np-lyrics-body">
                    {hasSynced ? (
                        <SyncedLyricsBody
                            lines={lines}
                            precomputedLinesData={precomputedLinesData}
                            focusIndex={focusIndex}
                            activeLineRef={activeLineRef}
                            effectivePosition={effectivePosition}
                            isRightPanel={isRightPanel}
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