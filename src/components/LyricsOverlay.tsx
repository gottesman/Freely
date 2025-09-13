import React, { useEffect, useCallback, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { useI18n } from '../core/i18n';
import { usePlaybackSelector } from '../core/playback';

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

interface SyncedLyrics {
  lines: InternalLyricsLine[];
}

interface LyricsOverlayProps {
  open: boolean;
  onClose: () => void;
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
}

const SyncedLyricsBody = React.memo<SyncedLyricsBodyProps>(({ lines, precomputedLinesData, focusIndex, activeLineRef }) => (
  <div className="lyrics-body" style={{ margin: 0 }}>
    {lines.map((ln, i) => {
      const data = precomputedLinesData[i];
      if (!data) return null;

      const { isFocus, isActive, wasActive, isPlayed, isLast, peakIdx, wordData } = data;

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
            (isLast ? ' last' : '') + // Use the new explicit state for .last
            (ln.isArtificial ? ' artificial' : '')
          }
          data-index={i}
          aria-current={isFocus ? 'true' : undefined}
        >
          {ln.parts ? (
            ln.parts.map((p, j) => {
              const wordStartPos = letterPosInLine;
              const isWordActive = wordData?.[j]?.isActive ?? false;
              const result = (
                <span key={j} className={`lyric-word${p.text.trim() === '' ? ' space' : ''}${isWordActive ? ' active' : ''}`}>
                  <span className="word-text">
                    {p.text.split('').map((letter, idx) => {
                      if (letter === ' ') return <span key={idx}>&nbsp;</span>;

                      const currentLetterPos = wordStartPos + idx;
                      const distance = Math.abs(currentLetterPos - peakIdx);
                      const t = Math.max(0, 1 - distance / 4);
                      const waveY = t * t * (3 - 2 * t) * 5;
                      const hasPeaked = peakIdx >= currentLetterPos;
                      const shouldHighlight = isPlayed || (isActive && hasPeaked);

                      return (
                        <span key={idx} className={`letter${shouldHighlight ? ' sung':''}`} style={{ transform: `translateY(${-waveY}px)`}}>
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
const sanitizeAndProcessLyrics = (lyrics: string | undefined, fallbackText: string): string => {
  if (!lyrics) return fallbackText;

  const cleanLyrics = lyrics
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');

  return cleanLyrics;
};

const LyricsOverlay = ({ open, onClose, lyrics, title, synced }: LyricsOverlayProps) => {
  const { t } = useI18n();
  const position = usePlaybackSelector(s => s.position);
  const playing = usePlaybackSelector(s => s.playing);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const [syncOffsetMs, setSyncOffsetMs] = useState<number>(0);

  // High-precision local position interpolation
  const [derivedPosition, setDerivedPosition] = useState<number>(position ?? 0);
  const basePosRef = useRef<number>(position ?? 0);
  const baseTsRef = useRef<number>(performance.now());
  const rafRef = useRef<number | null>(null);

  const tick = useCallback(() => {
    if (playing) {
      setDerivedPosition(basePosRef.current + (performance.now() - baseTsRef.current) / 1000);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [playing]);

  useEffect(() => {
    const now = performance.now();
    const curDerived = basePosRef.current + (now - baseTsRef.current) / 1000;
    if (Math.abs((position ?? 0) - curDerived) > 0.25) {
      basePosRef.current = position ?? 0;
      baseTsRef.current = now;
      setDerivedPosition(position ?? 0);
    }
  }, [position]);

  useEffect(() => {
    if (open && playing) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, [open, playing, tick]);

  useEffect(() => { if (open) setSyncOffsetMs(0); }, [open, title]);

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

  const hasSynced = !!(normalizedLyrics?.lines?.length);
  const lines = normalizedLyrics?.lines || [];
  const effectivePosition = (derivedPosition ?? position ?? 0) + (syncOffsetMs / 1000);

  const { focusIndex, activeIndices } = useMemo(() => {
    if (!hasSynced) return { focusIndex: -1, activeIndices: [] };

    const FOCUS_PRE_BUFFER_S = 0.1;
    const FOCUS_POST_BUFFER_S = 0.5;
    const ARTIFICIAL_INWARD_BUFFER_S = 0.3;

    const activeCandidates: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
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
      const isActive = activeIndices.includes(i);
      const wasActive = isActive && !isFocus;

      let isLast = false;
      if (isSongFinished) {
        // If song is over, only the very last line gets the .last class.
        isLast = i === lines.length - 1;
      } else {
        // Otherwise, the line before the focus is the .last line.
        isLast = i === focusIndex - 1;
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
  }, [hasSynced, lines, focusIndex, activeIndices, effectivePosition]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      onClose();
    }
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [open, handleKeyDown]);

  useLayoutEffect(() => {
    if (open && hasSynced && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [open, hasSynced, focusIndex]);

  useEffect(() => {
    const scrollContainer = scrollRef.current;
    const activeLine = activeLineRef.current;
    if (!open || !hasSynced || !scrollContainer || !activeLine) return;
    const observer = new ResizeObserver(() => {
      activeLine.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, [open, hasSynced, focusIndex]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const handleContentClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const processedLyrics = useMemo(() => sanitizeAndProcessLyrics(lyrics, t('lyrics.unavailable')), [lyrics, t]);

  if (!open) return null;

  return (
    <div className={`np-lyrics-overlay ${open ? 'active' : ''}`} aria-hidden={!open} aria-label={t('lyrics.overlay')} role="dialog" onClick={handleBackdropClick}>
      <div className="np-lyrics-scroll" onClick={handleContentClick} ref={scrollRef}>
        <div className="np-lyrics-body">
          <button type="button" className="player-icons np-overlay-close" aria-label={t('lyrics.close')} onClick={onClose}>
            <span className="material-symbols-rounded filled">close</span>
          </button>
          {hasSynced && (
            <div className="lyrics-sync-ctl" role="group" aria-label="Lyrics timing offset">
              <button className="btn btn-icon" onClick={() => setSyncOffsetMs(v => v - 100)} title="Decrease offset by 100ms" type="button">−</button>
              <span className="offset-readout">{syncOffsetMs}ms</span>
              <button className="btn btn-icon" onClick={() => setSyncOffsetMs(v => v + 100)} title="Increase offset by 100ms" type="button">+</button>
            </div>
          )}
          {hasSynced ? (
            <SyncedLyricsBody lines={lines} precomputedLinesData={precomputedLinesData} focusIndex={focusIndex} activeLineRef={activeLineRef} />
          ) : (
            <div className="lyrics-body" style={{ margin: 0 }} dangerouslySetInnerHTML={{ __html: processedLyrics }} />
          )}
        </div>
      </div>
    </div>
  );
};

const arePropsEqual = (prevProps: LyricsOverlayProps, nextProps: LyricsOverlayProps): boolean => {
  return (
    prevProps.open === nextProps.open &&
    prevProps.lyrics === nextProps.lyrics &&
    prevProps.title === nextProps.title &&
    prevProps.synced === nextProps.synced
  );
};

const OptimizedLyricsOverlay = React.memo(LyricsOverlay, arePropsEqual);
OptimizedLyricsOverlay.displayName = 'LyricsOverlay';

export default OptimizedLyricsOverlay;